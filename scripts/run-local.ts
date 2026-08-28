/**
 * Runs one job locally, exactly as the container does.
 *
 *   pnpm run:local ./job.json
 *
 * The only difference from production is where the spec comes from: here a
 * file, there the run's environment. Everything after that — clone, revoke,
 * agent, package, deliver — is the same code path, so a job that works here is
 * a job that works in a run.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: pnpm run:local <job-spec.json>");
  process.exit(2);
}

const spec = readFileSync(resolve(path), "utf8");
JSON.parse(spec); // fail here, with a readable error, rather than inside the run

const child = spawn(
  process.execPath,
  ["--import", "tsx", resolve(import.meta.dirname, "../src/entry.ts")],
  {
    stdio: "inherit",
    env: { ...process.env, AYOS_JOB_SPEC: spec },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
