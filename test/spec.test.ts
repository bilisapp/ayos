import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SPEC_ENV_VAR,
  SPEC_FILE_ENV_VAR,
  SpecError,
  loadJobSpec,
  scrubEnvironment,
} from "../src/spec/load.ts";

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44",
    repo: "org/app",
    base_ref: "main",
    base_sha: "a".repeat(40),
    clone_token: "ghs_token",
    llm_key: "sk-ant-key",
    signing_key: "A".repeat(43) + "=",
    task: { instructions: "Fix it." },
    callback_url: "https://caller.test/artifacts",
    ...overrides,
  };
}

describe("loadJobSpec", () => {
  it("reads and validates the spec from the environment", () => {
    const env = { [SPEC_ENV_VAR]: JSON.stringify(validSpec()) } as NodeJS.ProcessEnv;
    const spec = loadJobSpec(env);

    expect(spec.job_id).toBe("6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44");
    expect(spec.constraints.max_diff_lines).toBe(800);
  });

  /*
   * The whole point. The agent's `bash` is a child of this process and inherits
   * its environment: a spec left in `process.env` is `env | grep` away from the
   * clone token, the LLM key and this run's signing key.
   */
  it("deletes the spec from the environment it read it from", () => {
    const env = { [SPEC_ENV_VAR]: JSON.stringify(validSpec()) } as NodeJS.ProcessEnv;
    loadJobSpec(env);

    expect(env[SPEC_ENV_VAR]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("ghs_token");
  });

  it("rejects a spec that is missing a required field, naming it", () => {
    const { llm_key: _omitted, ...rest } = validSpec();
    const env = { [SPEC_ENV_VAR]: JSON.stringify(rest) } as NodeJS.ProcessEnv;

    expect(() => loadJobSpec(env)).toThrow(/llm_key/);
  });

  it("rejects a spec that is not JSON", () => {
    expect(() => loadJobSpec({ [SPEC_ENV_VAR]: "{oops" } as NodeJS.ProcessEnv)).toThrow(SpecError);
  });

  it("names both variables when neither is set", () => {
    expect(() => loadJobSpec({} as NodeJS.ProcessEnv)).toThrow(
      new RegExp(`${SPEC_ENV_VAR}.*${SPEC_FILE_ENV_VAR}`),
    );
  });

  describe("from a file", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "ayos-test-spec-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("reads the spec from a path", async () => {
      const path = join(dir, "job.json");
      await writeFile(path, JSON.stringify(validSpec({ repo: "org/from-file" })));
      const env = { [SPEC_FILE_ENV_VAR]: path } as NodeJS.ProcessEnv;

      expect(loadJobSpec(env).repo).toBe("org/from-file");
      expect(env[SPEC_FILE_ENV_VAR]).toBeUndefined();
    });

    it("says which path it could not read", () => {
      const path = join(dir, "missing.json");
      expect(() => loadJobSpec({ [SPEC_FILE_ENV_VAR]: path } as NodeJS.ProcessEnv)).toThrow(
        new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    });
  });
});

describe("scrubEnvironment", () => {
  it("removes credentials an operator or platform may have set by hand", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-leftover",
      GITHUB_TOKEN: "ghs_leftover",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;

    const removed = scrubEnvironment(env);

    expect(removed.sort()).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("reports nothing when there was nothing to remove", () => {
    expect(scrubEnvironment({ PATH: "/usr/bin" } as NodeJS.ProcessEnv)).toEqual([]);
  });
});
