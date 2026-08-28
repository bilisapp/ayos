import { describe, expect, it } from "vitest";
import { JOB_STATES, JobSpec, TERMINAL_STATES, isTerminal } from "../src/types.ts";

const VALID = {
  job_id: "6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44",
  repo: "org/app",
  base_ref: "main",
  base_sha: "abc1234",
  clone_token: "ghs_token",
  signing_key: "A".repeat(43) + "=",
  llm_key: "sk-ant-key",
  task: { instructions: "Fix the thing." },
  callback_url: "https://caller.test/artifacts",
};

const parse = (o: Record<string, unknown>) => JobSpec.safeParse({ ...VALID, ...o });

describe("valid specs", () => {
  it("parses a minimal spec and applies every default", () => {
    const res = JobSpec.parse(VALID);
    expect(res.task.context).toBe("");
    expect(res.task.links).toEqual([]);
    expect(res.constraints).toEqual({
      test_cmd: null,
      max_diff_lines: 800,
      path_denylist: [],
    });
    expect(res.constraints.timeout_s).toBeUndefined();
    // Every spec written before providers existed meant Anthropic.
    expect(res.llm_provider).toBe("anthropic");
  });

  it("keeps the provider the caller named", () => {
    expect(parse({ llm_provider: "openrouter" }).success).toBe(true);
    expect(JobSpec.parse({ ...VALID, llm_provider: "openai" }).llm_provider).toBe("openai");
  });

  it("refuses a provider it has no catalogue for", () => {
    // A runner that accepted an unknown provider would send a customer's key
    // somewhere it does not work, and only find out mid-run.
    expect(parse({ llm_provider: "mistral" }).success).toBe(false);
  });

  it("keeps supplied values instead of defaults", () => {
    const res = JobSpec.parse({
      ...VALID,
      task: {
        instructions: "Do it.",
        context: "stack trace",
        links: ["https://example.test/a"],
      },
      constraints: {
        timeout_s: 900,
        test_cmd: "php artisan test --compact",
        max_diff_lines: 200,
        path_denylist: [".github/**", ".env*"],
      },
    });
    expect(res.task.context).toBe("stack trace");
    expect(res.constraints.timeout_s).toBe(900);
    expect(res.constraints.test_cmd).toBe("php artisan test --compact");
    expect(res.constraints.max_diff_lines).toBe(200);
    expect(res.constraints.path_denylist).toEqual([".github/**", ".env*"]);
  });

  it("accepts a partial constraints object, defaulting the rest", () => {
    const res = JobSpec.parse({ ...VALID, constraints: { max_diff_lines: 50 } });
    expect(res.constraints).toEqual({ test_cmd: null, max_diff_lines: 50, path_denylist: [] });
  });

  it("accepts an explicitly null test_cmd (caller's CI verifies instead)", () => {
    expect(JobSpec.parse({ ...VALID, constraints: { test_cmd: null } }).constraints.test_cmd)
      .toBeNull();
  });

  it("accepts shas from short (7) to full (40) hex", () => {
    expect(parse({ base_sha: "abc1234" }).success).toBe(true);
    expect(parse({ base_sha: "a".repeat(40) }).success).toBe(true);
  });

  it("accepts repos with dots, dashes and underscores", () => {
    for (const repo of ["org/app", "my-org/my.app", "a_b/c-d.e"]) {
      expect(parse({ repo }).success, repo).toBe(true);
    }
  });
});

describe("repo format", () => {
  it("rejects anything that is not exactly org/name", () => {
    for (const repo of ["app", "org/", "/app", "org/app/extra", "", "org app", "org/ap p", "https://github.com/org/app"]) {
      const res = parse({ repo });
      expect(res.success, repo).toBe(false);
      if (!res.success) expect(res.error.issues[0]!.path).toEqual(["repo"]);
    }
  });

  it("reports the human-readable message", () => {
    const res = parse({ repo: "nope" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]!.message).toBe("repo must be org/name");
  });
});

describe("job_id", () => {
  it("rejects non-uuid ids", () => {
    for (const job_id of ["", "123", "not-a-uuid", "6c4b0f9e7a1d4a3b9f210d9a1c2e3f44"]) {
      expect(parse({ job_id }).success, job_id).toBe(false);
    }
  });

  it("rejects a missing job_id", () => {
    const { job_id, ...rest } = VALID;
    expect(JobSpec.safeParse(rest).success).toBe(false);
  });
});

describe("base_sha", () => {
  it("rejects non-hex, uppercase, too-short and too-long shas", () => {
    for (const base_sha of ["zzzzzzz", "ABC1234", "abc123", "a".repeat(41), "", "abc 123", "refs/heads/main"]) {
      const res = parse({ base_sha });
      expect(res.success, base_sha).toBe(false);
      if (!res.success) expect(res.error.issues[0]!.message).toBe("base_sha must be a hex commit sha");
    }
  });
});

describe("callback_url", () => {
  it("rejects non-URLs", () => {
    for (const callback_url of ["", "not a url", "/artifacts", "caller.test/artifacts"]) {
      expect(parse({ callback_url }).success, callback_url).toBe(false);
    }
  });

  it("rejects non-URL entries in task.links", () => {
    const res = parse({ task: { instructions: "x", links: ["https://ok.test", "nope"] } });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0]!.path).toEqual(["task", "links", 1]);
  });
});

describe("other required fields", () => {
  it("rejects empty credentials, base_ref and instructions", () => {
    expect(parse({ clone_token: "" }).success).toBe(false);
    expect(parse({ llm_key: "" }).success).toBe(false);
    expect(parse({ base_ref: "" }).success).toBe(false);
    expect(parse({ task: { instructions: "" } }).success).toBe(false);
  });

  // The ceiling is the platform's own maximum run duration: 24 hours. A spec
  // asking for longer would be accepted here and then truncated by the run,
  // which is the confusing failure this rejects up front.
  it("rejects an out-of-range or non-integer timeout", () => {
    expect(parse({ constraints: { timeout_s: 0 } }).success).toBe(false);
    expect(parse({ constraints: { timeout_s: -1 } }).success).toBe(false);
    expect(parse({ constraints: { timeout_s: 86401 } }).success).toBe(false);
    expect(parse({ constraints: { timeout_s: 12.5 } }).success).toBe(false);
    expect(parse({ constraints: { timeout_s: 86400 } }).success).toBe(true);
    expect(parse({ constraints: { timeout_s: 900 } }).success).toBe(true);
  });

  it("rejects a non-positive max_diff_lines", () => {
    expect(parse({ constraints: { max_diff_lines: 0 } }).success).toBe(false);
    expect(parse({ constraints: { max_diff_lines: -5 } }).success).toBe(false);
  });

  it("collects multiple issues rather than stopping at the first", () => {
    const res = parse({ repo: "bad", job_id: "bad", base_sha: "zzz" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("llm_host (optional gateway override)", () => {
  it("is absent by default", () => {
    expect(JobSpec.parse(VALID).llm_host).toBeUndefined();
  });

  it("accepts a bare hostname", () => {
    for (const llm_host of ["api.anthropic.com", "gateway.internal", "llm-proxy.example.test"]) {
      expect(parse({ llm_host }).success, llm_host).toBe(true);
    }
  });

  it("rejects anything that is not a bare hostname (no scheme, path, port or creds)", () => {
    for (const llm_host of [
      "https://api.anthropic.com",
      "api.anthropic.com/v1",
      "api.anthropic.com:443",
      "user@host",
      "",
      "host name",
    ]) {
      expect(parse({ llm_host }).success, llm_host).toBe(false);
    }
  });
});

describe("job states", () => {
  it("marks exactly the four terminal states as terminal", () => {
    expect(JOB_STATES.filter(isTerminal)).toEqual([...TERMINAL_STATES]);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("packaging")).toBe(false);
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("timeout")).toBe(true);
  });
});
