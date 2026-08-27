/**
 * Starts just the Rivet engine, for when you want to run the server separately
 * (two terminals, a debugger attached, etc.).
 *
 *   pnpm engine          # terminal 1
 *   AYOS_EXTERNAL_ENGINE=1 pnpm dev:server   # terminal 2
 */
import { spawn } from "node:child_process";
import { getEnginePath } from "@rivetkit/engine-cli";

spawn(getEnginePath(), ["start"], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
