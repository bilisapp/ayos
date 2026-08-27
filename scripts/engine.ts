/**
 * Starts just the Rivet engine, for when you want to run the server separately
 * (two terminals, a debugger attached, etc.).
 *
 *   pnpm engine          # terminal 1
 *   AYOS_EXTERNAL_ENGINE=1 pnpm dev:server   # terminal 2
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = `@rivetkit/engine-cli-${process.platform}-${process.arch}`;
const dir = join(require.resolve(`${pkg}/package.json`), "..");

spawn(join(dir, "rivet-engine"), ["start"], { stdio: "inherit" }).on("exit", (code) =>
  process.exit(code ?? 0),
);
