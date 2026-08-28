import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runJob, type RunnerDeps } from "../src/job/runner.ts";
import { JobSpec, type Artifact } from "../src/types.ts";
import type { AgentSession, AgentSessionFactory, AgentTurn } from "../src/agent/session.ts";
import type { EventType } from "../src/events/schema.ts";
import { commitAll, git, initRepo, installGitConfig, makeTempDir, writeIn } from "./helpers/tempRepo.ts";

/**
 * The runner drives real git against a real checkout, so the origin is a
 * `file://` repository under the OS temp dir, reached through the same
 * `insteadOf` rewrite `clone.test.ts` uses. Only the agent is a fake: it edits
 * the working tree the way Pi would, and everything downstream of that — the
 * diff, the denylist, the artifact — is the production code path.
 */
const TIMEOUT = 30_000;
const CLONE_TOKEN = "ghs_CloneTokenThatMustNotLeak0123456789";
const LLM_KEY = "sk-ant-LlmKeyThatMustNotLeak0123456789";

let root: string;
let originsRoot: string;
let originPath: string;
let headSha: string;
let restoreGitConfig: () => void;

beforeAll(async () => {
  root = await makeTempDir("ayos-runner-fixture-");
  originsRoot = join(root, "origins");
  originPath = join(originsRoot, "org", "app.git");

  restoreGitConfig = await installGitConfig(
    root,
    `[url "file://${originsRoot}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  await initRepo(originPath);
  await writeIn(originPath, "README.md", "hello\n");
  await writeIn(originPath, "app/Foo.php", "<?php\n// one\n");
  await writeIn(originPath, ".github/workflows/ci.yml", "name: ci\n");
  headSha = await commitAll(originPath, "one");
}, TIMEOUT);

afterAll(async () => {
  restoreGitConfig?.();
  await rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ fixtures */

type Edit = (cwd: string) => Promise<void> | void;

/** An agent that performs `edit` and then says `summary`. */
function fakeAgent(
  edit: Edit = () => {},
  opts: { summary?: string; turns?: AgentTurn[]; throws?: Error; hang?: boolean } = {},
): AgentSessionFactory & { created: { cwd: string; systemPrompt: string }[]; disposed: number } {
  const created: { cwd: string; systemPrompt: string }[] = [];
  let disposed = 0;

  const factory = {
    created,
    get disposed() {
      return disposed;
    },
    async create(o: { cwd: string; systemPrompt: string }): Promise<AgentSession> {
      created.push({ cwd: o.cwd, systemPrompt: o.systemPrompt });
      return {
        async run(runOpts) {
          for (const turn of opts.turns ?? []) runOpts.onTurn(turn);
          if (opts.throws) throw opts.throws;
          await edit(o.cwd);
          if (opts.hang)
            await new Promise<void>((resolve) => {
              // Already aborted is the common case here: an `abort` listener
              // added to a signal that has fired never runs.
              if (runOpts.signal?.aborted) return resolve();
              runOpts.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          return { summary: opts.summary ?? "Did the thing.", stopped: false };
        },
        async dispose() {
          disposed++;
        },
      };
    },
  };
  return factory as AgentSessionFactory & typeof factory;
}

function spec(overrides: Record<string, unknown> = {}): JobSpec {
  return JobSpec.parse({
    job_id: "6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44",
    repo: "org/app",
    base_ref: "main",
    base_sha: headSha,
    clone_token: CLONE_TOKEN,
    llm_key: LLM_KEY,
    signing_key: "A".repeat(43) + "=",
    task: { instructions: "Fix the thing." },
    callback_url: "https://caller.test/artifacts",
    ...overrides,
  });
}

interface RunResult {
  artifact: Artifact;
  events: { type: EventType; data: Record<string, unknown> }[];
  states: string[];
  revoked: string[];
}

async function run(
  agents: AgentSessionFactory,
  overrides: Record<string, unknown> = {},
  deps: Partial<RunnerDeps> = {},
  signal?: AbortSignal,
): Promise<RunResult> {
  const events: RunResult["events"] = [];
  const states: string[] = [];
  const revoked: string[] = [];

  const artifact = await runJob(
    spec(overrides),
    {
      agents,
      emit: (type, data) => events.push({ type, data }),
      onState: (s) => states.push(s),
      defaultTimeoutS: 60,
      revoke: async (token) => {
        revoked.push(token);
        return { revoked: true, status: 204 };
      },
      ...deps,
    },
    signal,
  );
  return { artifact, events, states, revoked };
}

/* -------------------------------------------------------------- happy path */

describe("a job that produces a diff", () => {
  let result: RunResult;

  beforeAll(async () => {
    result = await run(
      fakeAgent(async (cwd) => {
        await writeFile(join(cwd, "app/Foo.php"), "<?php\n// fixed\n");
        await writeFile(join(cwd, "app/New.php"), "<?php\n// added\n");
      }),
    );
  }, TIMEOUT);

  it("finishes done", () => {
    expect(result.artifact.status).toBe("done");
    expect(result.artifact.report.error).toBeNull();
  });

  it("walks the phases in order", () => {
    expect(result.states).toEqual(["cloning", "fixing", "packaging", "done"]);
  });

  it("packages a diff against base_sha that includes a NEW file", () => {
    expect(result.artifact.diff).toContain("app/Foo.php");
    expect(result.artifact.diff).toContain("app/New.php");
    expect(result.artifact.report.files_touched.sort()).toEqual(["app/Foo.php", "app/New.php"]);
  });

  it("carries the agent's own words as the summary", () => {
    expect(result.artifact.report.summary).toBe("Did the thing.");
  });

  it("reports no tests when no test_cmd was set", () => {
    expect(result.artifact.report.tests).toBeNull();
  });

  it("ends with a done event", () => {
    expect(result.events.at(-1)).toEqual({ type: "done", data: { status: "done" } });
  });
});

/* ------------------------------------------------------- credential handling */

describe("the clone token", () => {
  it("is revoked after the clone and BEFORE the agent runs", async () => {
    const order: string[] = [];
    const agents = fakeAgent(() => {
      order.push("agent");
    });

    await run(
      agents,
      {},
      {
        revoke: async () => {
          order.push("revoke");
          return { revoked: true, status: 204 };
        },
      },
    );

    expect(order).toEqual(["revoke", "agent"]);
  }, TIMEOUT);

  it("is the token from the spec", async () => {
    const result = await run(fakeAgent());
    expect(result.revoked).toEqual([CLONE_TOKEN]);
  }, TIMEOUT);

  /*
   * `contents: read` on one repo, expiring within the hour anyway. Failing the
   * whole job over a failed revocation would trade a small residual risk for a
   * large certain one — but it must be VISIBLE that it failed.
   */
  it("does not fail the job when revocation fails, and says so in the events", async () => {
    const result = await run(
      fakeAgent(),
      {},
      { revoke: async () => ({ revoked: false, status: 500, error: "boom" }) },
    );

    expect(result.artifact.status).toBe("done");
    const revokeEvent = result.events.find((e) => "token_revoked" in e.data);
    expect(revokeEvent?.data.token_revoked).toBe(false);
    expect(revokeEvent?.data.revoke_error).toBe("boom");
  }, TIMEOUT);
});

describe("redaction", () => {
  it("scrubs the clone token and llm key from every event and from the artifact", async () => {
    const result = await run(
      fakeAgent(async (cwd) => {
        await writeFile(join(cwd, "app/Foo.php"), "<?php\n// fixed\n");
      }),
      {},
      {},
    );

    const dump = JSON.stringify({ artifact: result.artifact, events: result.events });
    expect(dump).not.toContain(CLONE_TOKEN);
    expect(dump).not.toContain(LLM_KEY);
  }, TIMEOUT);

  it("scrubs a secret the AGENT echoed into a tool result", async () => {
    const agents = fakeAgent(() => {}, {
      turns: [
        {
          type: "tool_result",
          data: { tool_call_id: "1", output: `printenv said ${CLONE_TOKEN} and ${LLM_KEY}` },
        },
      ],
      summary: `I found ${LLM_KEY} lying around.`,
    });

    const result = await run(agents);
    const dump = JSON.stringify({ artifact: result.artifact, events: result.events });

    expect(dump).not.toContain(CLONE_TOKEN);
    expect(dump).not.toContain(LLM_KEY);
    expect(dump).toContain("[redacted]");
  }, TIMEOUT);
});

/* ------------------------------------------------------------- the guardrails */

describe("path_denylist", () => {
  it("fails the job and withholds the diff when the agent touched a denied path", async () => {
    const result = await run(
      fakeAgent(async (cwd) => {
        await writeFile(join(cwd, ".github/workflows/ci.yml"), "name: pwned\n");
      }),
      { constraints: { path_denylist: [".github/**", ".env*"] } },
    );

    expect(result.artifact.status).toBe("failed");
    expect(result.artifact.diff).toBeNull();
    expect(result.artifact.report.error).toContain(".github/workflows/ci.yml");
  }, TIMEOUT);

  it("allows an untouched denylist through", async () => {
    const result = await run(
      fakeAgent(async (cwd) => {
        await writeFile(join(cwd, "README.md"), "hello again\n");
      }),
      { constraints: { path_denylist: [".github/**"] } },
    );

    expect(result.artifact.status).toBe("done");
  }, TIMEOUT);
});

describe("max_diff_lines", () => {
  it("fails the job when the diff is too big", async () => {
    const result = await run(
      fakeAgent(async (cwd) => {
        await writeFile(
          join(cwd, "app/Big.php"),
          Array.from({ length: 500 }, (_, i) => `// line ${i}`).join("\n"),
        );
      }),
      { constraints: { max_diff_lines: 20 } },
    );

    expect(result.artifact.status).toBe("failed");
    expect(result.artifact.report.error).toMatch(/exceeds max_diff_lines/);
  }, TIMEOUT);
});

describe("test_cmd", () => {
  it("records a passing suite", async () => {
    const result = await run(fakeAgent(), { constraints: { test_cmd: "exit 0" } });

    expect(result.artifact.status).toBe("done");
    expect(result.artifact.report.tests?.passed).toBe(true);
    expect(result.states).toContain("testing");
  }, TIMEOUT);

  /*
   * A red suite is a RESULT, not an error: the caller decides what to do with a
   * diff whose tests fail. Turning it into a failed job would throw away work
   * the caller may still want to look at.
   */
  it("records a failing suite without failing the job", async () => {
    const result = await run(
      fakeAgent(async (cwd) => {
        await writeFile(join(cwd, "app/Foo.php"), "<?php\n// fixed\n");
      }),
      { constraints: { test_cmd: "echo 'FAILURES!'; exit 1" } },
    );

    expect(result.artifact.status).toBe("done");
    expect(result.artifact.diff).toContain("app/Foo.php");
    expect(result.artifact.report.tests?.passed).toBe(false);
    expect(result.artifact.report.tests?.output_tail).toContain("FAILURES!");
  }, TIMEOUT);

  it("fails plainly when the command needs a runtime the image does not have", async () => {
    const result = await run(fakeAgent(), {
      constraints: { test_cmd: "definitely-not-a-real-runtime-xyz artisan test" },
    });

    // Not a runtime we recognise, so it runs and simply fails — the preflight
    // only guards the interpreters people actually configure.
    expect(result.artifact.report.tests?.passed).toBe(false);
  }, TIMEOUT);

  it("refuses a php test_cmd up front rather than reporting a confusing failure", async () => {
    const result = await run(fakeAgent(), {
      constraints: { test_cmd: "php artisan test --compact" },
    });

    if (result.artifact.status === "failed") {
      expect(result.artifact.report.error).toMatch(/not installed in the runner image/);
      expect(result.artifact.report.error).toMatch(/test_cmd to null/);
    } else {
      // A dev machine with php on PATH: then it really did run.
      expect(result.artifact.report.tests).not.toBeNull();
    }
  }, TIMEOUT);
});

/* ----------------------------------------------------------------- failures */

describe("failure paths always still produce an artifact", () => {
  it("fails cleanly when the clone fails", async () => {
    const result = await run(fakeAgent(), { repo: "org/does-not-exist" });

    expect(result.artifact.status).toBe("failed");
    expect(result.artifact.report.error).toMatch(/clone failed/);
    expect(result.artifact.diff).toBeNull();
  }, TIMEOUT);

  it("does not revoke a token when the clone never succeeded", async () => {
    const result = await run(fakeAgent(), { repo: "org/does-not-exist" });
    expect(result.revoked).toEqual([]);
  }, TIMEOUT);

  it("turns an agent that throws into a failed artifact, not a rejection", async () => {
    const result = await run(fakeAgent(() => {}, { throws: new Error("model exploded") }));

    expect(result.artifact.status).toBe("failed");
    expect(result.artifact.report.error).toContain("model exploded");
  }, TIMEOUT);

  it("disposes the agent session even when the run fails", async () => {
    const agents = fakeAgent(() => {}, { throws: new Error("nope") });
    await run(agents);
    expect(agents.disposed).toBe(1);
  }, TIMEOUT);
});

describe("cancellation", () => {
  it("reports cancelled when the caller aborts mid-agent", async () => {
    const ac = new AbortController();
    const agents = fakeAgent(() => ac.abort("cancelled"), { hang: true });

    const result = await run(agents, {}, {}, ac.signal);

    expect(result.artifact.status).toBe("cancelled");
    expect(result.events.at(-1)).toEqual({ type: "done", data: { status: "cancelled" } });
  }, TIMEOUT);

  it("reports timeout when the job budget runs out", async () => {
    const agents = fakeAgent(() => {}, { hang: true });
    const result = await run(agents, { constraints: { timeout_s: 1 } });

    expect(result.artifact.status).toBe("timeout");
  }, TIMEOUT);
});

/* --------------------------------------------------------------- the agent's cwd */

describe("the agent session", () => {
  it("is rooted in the checkout and given the safety invariants as a system prompt", async () => {
    const agents = fakeAgent();
    await run(agents);

    const created = agents.created[0]!;
    expect(created.cwd).toMatch(/ayos-/);
    expect(created.systemPrompt).toContain("Invariants");
    expect(created.systemPrompt).toContain("never publish");
  }, TIMEOUT);

  it("deletes the checkout when the job ends", async () => {
    const agents = fakeAgent();
    await run(agents);

    const cwd = agents.created[0]!.cwd;
    await expect(readFile(join(cwd, "README.md"))).rejects.toThrow();
  }, TIMEOUT);
});
