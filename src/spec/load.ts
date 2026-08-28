import { readFileSync } from "node:fs";
import { JobSpec } from "../types.ts";

export const SPEC_ENV_VAR = "AYOS_JOB_SPEC";
export const SPEC_FILE_ENV_VAR = "AYOS_JOB_SPEC_FILE";

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

/**
 * The job spec arrives as environment, not as an HTTP body: a Serverless Job
 * run has no inbound surface, so the platform's per-run environment variables
 * and Secret Manager references are the delivery mechanism.
 *
 * `AYOS_JOB_SPEC` holds the JSON directly; `AYOS_JOB_SPEC_FILE` points at a
 * file, for a spec too large for an env var or mounted from a secret store.
 *
 * **The variables are deleted from `process.env` as soon as they are read**,
 * and so is everything else this run was given. That is not decoration: the
 * agent's `bash` tool runs as a child of THIS process and inherits its
 * environment, so a spec left in `process.env` is one `env` away from the
 * clone token, the LLM key and the run's signing key. The parsed spec lives in
 * a local, and the credentials in it are handed only to the code that needs
 * each one.
 */
export function loadJobSpec(env: NodeJS.ProcessEnv = process.env): JobSpec {
  const inline = env[SPEC_ENV_VAR];
  const path = env[SPEC_FILE_ENV_VAR];

  let raw: string;
  if (inline) {
    raw = inline;
  } else if (path) {
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new SpecError(`could not read ${SPEC_FILE_ENV_VAR}=${path}: ${String(err)}`);
    }
  } else {
    throw new SpecError(`no job spec: set ${SPEC_ENV_VAR} or ${SPEC_FILE_ENV_VAR}`);
  }

  delete env[SPEC_ENV_VAR];
  delete env[SPEC_FILE_ENV_VAR];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new SpecError("job spec is not valid JSON");
  }

  const parsed = JobSpec.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new SpecError(`invalid job spec — ${issues}`);
  }
  return parsed.data;
}

/**
 * Variables that must not survive into the agent's environment even when they
 * did not arrive inside the spec — an operator setting one by hand, or a
 * platform injecting a secret reference under its own name.
 */
const SENSITIVE_ENV = [
  "AYOS_SIGNING_KEY",
  "AYOS_CLONE_TOKEN",
  "AYOS_LLM_KEY",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "SCW_SECRET_KEY",
  "SCW_ACCESS_KEY",
];

/**
 * Strip credentials from the environment the agent will inherit. Called once,
 * before the agent session opens. Values that are still needed (the LLM key)
 * are passed in memory to the one component that uses them.
 */
export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of SENSITIVE_ENV) {
    if (env[name] !== undefined) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
