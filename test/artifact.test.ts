import { describe, expect, it, vi } from "vitest";
import { packageDiff, runTests, violatesDenylist } from "../src/artifact/package.ts";
import { deliverArtifact } from "../src/artifact/callback.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "../src/auth/hmac.ts";
import { WORKDIR } from "../src/git/clone.ts";
import type { Artifact } from "../src/types.ts";
import { FakeSandbox } from "./helpers/fakeSandbox.ts";

/* ------------------------------------------------------------------ denylist */

describe("violatesDenylist", () => {
  const DENY = [".github/**", ".env*"];

  it("is a no-op when the caller supplied no denylist", () => {
    expect(violatesDenylist([".github/workflows/ci.yml", ".env"], [])).toEqual([]);
  });

  it("matches .env* against .env.production", () => {
    expect(violatesDenylist([".env.production"], DENY)).toEqual([".env.production"]);
    expect(violatesDenylist([".env"], DENY)).toEqual([".env"]);
    expect(violatesDenylist([".env.local"], DENY)).toEqual([".env.local"]);
  });

  it("does not match innocent paths that merely contain the words", () => {
    const innocent = [
      "app/Services/Env.php",
      "docs/github.md",
      "src/env/loader.ts",
      "config/dotenv.php",
      "packages/x/.github-ish.md",
    ];
    expect(violatesDenylist(innocent, DENY)).toEqual([]);
  });

  it("* does not cross a path separator", () => {
    // `.env*` must not swallow `.env/secret` style nesting
    expect(violatesDenylist([".env/secrets/prod.key"], [".env*"])).toEqual([]);
    expect(violatesDenylist(["app/Foo.php"], ["app/*"])).toEqual(["app/Foo.php"]);
    expect(violatesDenylist(["app/Sub/Foo.php"], ["app/*"])).toEqual([]);
  });

  it("? matches exactly one non-separator character", () => {
    expect(violatesDenylist(["a1.txt"], ["a?.txt"])).toEqual(["a1.txt"]);
    expect(violatesDenylist(["a12.txt"], ["a?.txt"])).toEqual([]);
  });

  it("treats the pattern's dots literally, not as regex wildcards", () => {
    expect(violatesDenylist(["xenv.production"], [".env*"])).toEqual([]);
  });

  it("returns every offending file, preserving input order", () => {
    const files = [".env.production", "app/Ok.php", ".env.staging"];
    expect(violatesDenylist(files, DENY)).toEqual([".env.production", ".env.staging"]);
  });

  it("matches an exact literal path", () => {
    expect(violatesDenylist(["deploy/prod.yml"], ["deploy/prod.yml"])).toEqual(["deploy/prod.yml"]);
    expect(violatesDenylist(["deploy/prod.yaml"], ["deploy/prod.yml"])).toEqual([]);
  });

  // ---- BUG (src/artifact/package.ts globToRegExp): `dir/**` compiles to
  // ^dir/(?:.*/)?$ which only matches directory-ish paths, never a file beneath
  // the directory. `.github/**` therefore matches NOTHING under .github/, so the
  // spec's own example denylist entry silently fails to catch a CI edit.
  it.fails("BUG: .github/** should match .github/workflows/ci.yml", () => {
    expect(violatesDenylist([".github/workflows/ci.yml"], [".github/**"])).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  it.fails("BUG: dir/** should match a file directly inside dir", () => {
    expect(violatesDenylist([".github/dependabot.yml"], [".github/**"])).toEqual([
      ".github/dependabot.yml",
    ]);
  });

  it("documents the current (broken) `**` behaviour so a fix is a visible change", () => {
    expect(violatesDenylist([".github/workflows/ci.yml", ".github/x.yml"], [".github/**"])).toEqual(
      [],
    );
  });

  it("still keeps innocent paths out even under the broken ** handling", () => {
    expect(violatesDenylist(["docs/github.md", "app/Services/Env.php"], [".github/**"])).toEqual([]);
  });
});

/* --------------------------------------------------------------- packageDiff */

const DIFF_HEADER = "diff --git a/app/Foo.php b/app/Foo.php";

describe("packageDiff", () => {
  function sandboxWith(names: string, diff: string) {
    return new FakeSandbox((call) => {
      if (call.args[0] === "add") return { exitCode: 0 };
      if (call.args.includes("--name-only")) return { stdout: names };
      if (call.args[0] === "diff") return { stdout: diff };
      return {};
    });
  }

  it("stages everything then diffs against the pinned base sha in the workdir", async () => {
    const sb = sandboxWith("app/Foo.php\n", `${DIFF_HEADER}\n+x\n`);
    await packageDiff(sb, "abc1234", 800);

    expect(sb.execCalls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["git", "add", "-A"],
      ["git", "diff", "--cached", "--name-only", "abc1234"],
      ["git", "diff", "--cached", "abc1234"],
    ]);
    for (const call of sb.execCalls) expect(call.opts?.cwd).toBe(WORKDIR);
  });

  it("parses files_touched, trimming and dropping blank lines", async () => {
    const sb = sandboxWith("app/Foo.php\n  app/Bar.php  \n\n", `${DIFF_HEADER}\n`);
    const res = await packageDiff(sb, "abc1234", 800);
    expect(res.filesTouched).toEqual(["app/Foo.php", "app/Bar.php"]);
  });

  it("returns an empty diff untouched (agent made no change)", async () => {
    const sb = sandboxWith("", "");
    const res = await packageDiff(sb, "abc1234", 800);
    expect(res).toEqual({ diff: "", filesTouched: [], lineCount: 0, truncated: false });
  });

  it("does not truncate a diff at exactly the limit", async () => {
    const diff = Array.from({ length: 10 }, (_, i) => `+line ${i}`).join("\n");
    const sb = sandboxWith("app/Foo.php\n", diff);
    const res = await packageDiff(sb, "abc1234", 10);
    expect(res.truncated).toBe(false);
    expect(res.diff).toBe(diff);
    expect(res.lineCount).toBe(10);
  });

  it("truncates a diff over max_diff_lines and reports the real line count", async () => {
    const diff = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join("\n");
    const sb = sandboxWith("app/Foo.php\n", diff);
    const res = await packageDiff(sb, "abc1234", 10);

    expect(res.truncated).toBe(true);
    expect(res.lineCount).toBe(50);
    const lines = res.diff.split("\n");
    expect(lines.slice(0, 10)).toEqual(diff.split("\n").slice(0, 10));
    expect(lines.at(-1)).toBe("...[diff truncated at 10 lines; 50 total]");
    expect(res.diff).not.toContain("+line 10");
    // files_touched survives truncation — the caller still knows the blast radius
    expect(res.filesTouched).toEqual(["app/Foo.php"]);
  });
});

/* ------------------------------------------------------------------ runTests */

describe("runTests", () => {
  it("runs the command through a login shell in the workdir and maps exit 0 to passed", async () => {
    const sb = new FakeSandbox(() => ({ exitCode: 0, stdout: "OK (12 tests)" }));
    const res = await runTests(sb, "php artisan test --compact", { timeoutMs: 5000 });

    expect(sb.execCalls[0]!.cmd).toBe("sh");
    expect(sb.execCalls[0]!.args).toEqual(["-lc", "php artisan test --compact"]);
    expect(sb.execCalls[0]!.opts?.cwd).toBe(WORKDIR);
    expect(sb.execCalls[0]!.opts?.timeoutMs).toBe(5000);
    expect(res.passed).toBe(true);
    expect(res.cmd).toBe("php artisan test --compact");
    expect(res.output_tail).toBe("OK (12 tests)");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("maps a non-zero exit to failed and keeps stderr in the tail", async () => {
    const sb = new FakeSandbox(() => ({ exitCode: 1, stdout: "1 failed", stderr: "boom" }));
    const res = await runTests(sb, "pnpm test");
    expect(res.passed).toBe(false);
    expect(res.output_tail).toContain("1 failed");
    expect(res.output_tail).toContain("boom");
  });

  it("treats any non-zero code as failure, not just 1", async () => {
    const sb = new FakeSandbox(() => ({ exitCode: 137, stdout: "killed" }));
    expect((await runTests(sb, "x")).passed).toBe(false);
  });

  it("keeps the TAIL of huge output, capped at 8 KB", async () => {
    const stdout = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
    const sb = new FakeSandbox(() => ({ exitCode: 1, stdout }));
    const res = await runTests(sb, "noisy");

    expect(res.output_tail.length).toBeLessThanOrEqual(8192);
    expect(res.output_tail.endsWith("line 19999")).toBe(true);
    expect(res.output_tail).not.toContain("line 0\n");
  });

  it("passes the abort signal through", async () => {
    const ac = new AbortController();
    const sb = new FakeSandbox(() => ({ exitCode: 0 }));
    await runTests(sb, "x", { signal: ac.signal });
    expect(sb.execCalls[0]!.opts?.signal).toBe(ac.signal);
  });
});

/* ----------------------------------------------------------- deliverArtifact */

const SECRET = "shared-secret-for-the-callback";

function artifact(): Artifact {
  return {
    job_id: "6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44",
    status: "done",
    diff: `${DIFF_HEADER}\n+fixed\n`,
    report: {
      summary: "Fixed it.",
      files_touched: ["app/Foo.php"],
      tests: { cmd: "php artisan test", passed: true, output_tail: "OK" },
      durations: { clone_ms: 10, agent_ms: 20, test_ms: 30 },
      links: ["https://example.test/1"],
    },
    events: [],
  };
}

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(statuses: (number | Error)[]) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = statuses[calls.length - 1] ?? statuses.at(-1)!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("deliverArtifact", () => {
  const noSleep = vi.fn(async () => {});

  it("succeeds on the first try and does not sleep", async () => {
    const { impl, calls } = stubFetch([200]);
    const sleep = vi.fn(async () => {});
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep,
    });

    expect(res).toEqual({ delivered: true, attempts: 1, lastStatus: 200 });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls[0]!.url).toBe("https://caller.test/artifacts");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("sends the artifact as JSON with HMAC headers that verify() accepts", async () => {
    const { impl, calls } = stubFetch([204]);
    const art = artifact();
    await deliverArtifact("https://caller.test/artifacts", art, SECRET, {
      fetchImpl: impl,
      sleep: noSleep,
    });

    const { init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;

    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(body)).toEqual(art);
    expect(headers[SIGNATURE_HEADER]).toMatch(/^sha256=[0-9a-f]{64}$/);

    expect(
      verify(SECRET, body, {
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
      }),
    ).toEqual({ ok: true });

    // and the signature is genuinely over this body
    expect(
      verify(SECRET, `${body} `, {
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
      }).ok,
    ).toBe(false);
    // ...with the right secret
    expect(
      verify("wrong-secret", body, {
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
      }).ok,
    ).toBe(false);
  });

  it("re-signs each retry so the timestamp stays inside the window", async () => {
    const { impl, calls } = stubFetch([500, 200]);
    await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep: noSleep,
      backoffMs: [0, 0],
    });
    for (const c of calls) {
      const h = c.init.headers as Record<string, string>;
      expect(
        verify(SECRET, c.init.body as string, {
          signature: h[SIGNATURE_HEADER],
          timestamp: h[TIMESTAMP_HEADER],
        }).ok,
      ).toBe(true);
    }
  });

  it("retries after a 500 and reports success on the second attempt", async () => {
    const { impl, calls } = stubFetch([500, 200]);
    const sleep = vi.fn(async () => {});
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep,
      backoffMs: [111, 222],
    });

    expect(res).toEqual({ delivered: true, attempts: 2, lastStatus: 200 });
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(111);
  });

  it("gives up after 3 attempts and reports the last status", async () => {
    const { impl, calls } = stubFetch([500, 502, 503]);
    const sleep = vi.fn(async () => {});
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep,
      backoffMs: [1, 2, 3],
    });

    expect(res.delivered).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.lastStatus).toBe(503);
    expect(res.lastError).toBe("http 503");
    expect(calls).toHaveLength(3);
    // sleeps between attempts only — never after the final one
    expect(sleep.mock.calls).toEqual([[1], [2]]);
  });

  it("does not retry a 422 — the caller rejected the artifact", async () => {
    const { impl, calls } = stubFetch([422, 200]);
    const sleep = vi.fn(async () => {});
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep,
    });

    expect(res).toEqual({
      delivered: false,
      attempts: 1,
      lastStatus: 422,
      lastError: "http 422",
    });
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])("does not retry %i", async (status) => {
    const { impl, calls } = stubFetch([status, 200]);
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep: noSleep,
    });
    expect(res.delivered).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([408, 429])("does retry %i (transient)", async (status) => {
    const { impl, calls } = stubFetch([status, 200]);
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep: noSleep,
    });
    expect(res.delivered).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries network errors and surfaces the message on final failure", async () => {
    const { impl, calls } = stubFetch([new Error("ECONNREFUSED")]);
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep: noSleep,
    });

    expect(calls).toHaveLength(3);
    expect(res.delivered).toBe(false);
    expect(res.attempts).toBe(3);
    expect(res.lastError).toBe("ECONNREFUSED");
    expect(res.lastStatus).toBeUndefined();
  });

  it("recovers when the network error is transient", async () => {
    const { impl } = stubFetch([new Error("EAI_AGAIN"), 200]);
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep: noSleep,
    });
    expect(res).toEqual({ delivered: true, attempts: 2, lastStatus: 200 });
  });

  it("honours a custom attempt count and reuses the last backoff when it runs short", async () => {
    const { impl, calls } = stubFetch([500, 500, 500, 500, 200]);
    const sleep = vi.fn(async () => {});
    const res = await deliverArtifact("https://caller.test/artifacts", artifact(), SECRET, {
      fetchImpl: impl,
      sleep,
      attempts: 5,
      backoffMs: [7, 9],
    });
    expect(res.delivered).toBe(true);
    expect(calls).toHaveLength(5);
    expect(sleep.mock.calls).toEqual([[7], [9], [9], [9]]);
  });
});
