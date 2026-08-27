/**
 * Production entrypoint: engine + Ayos in one container.
 *
 * Same shape as scripts/dev.ts but without the watcher, and stricter — if
 * either process dies the container exits, so the orchestrator restarts it
 * rather than leaving a half-running service that still answers /healthz.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getEnginePath } from "@rivetkit/engine-cli";

const ENGINE_URL = process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6420";

function engineBinary(): string {
  // The official resolver: it knows the platform package names (linux ships a
  // musl-static build under a -musl suffix) and honours RIVET_ENGINE_BINARY.
  return getEnginePath();
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${ENGINE_URL}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  // Give the engine a moment to close its database cleanly.
  setTimeout(() => process.exit(code), 2000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(0));

console.log("[serve] starting rivet engine…");
const engine = spawn(engineBinary(), ["start"], { stdio: ["ignore", "inherit", "inherit"] });
children.push(engine);
engine.on("exit", (code) => {
  if (!shuttingDown) {
    console.error(`[serve] engine exited (${code}) — bringing the container down`);
    shutdown(1);
  }
});

const deadline = Date.now() + 120_000;
while (!(await healthy())) {
  if (Date.now() > deadline) {
    console.error(`[serve] engine never became healthy at ${ENGINE_URL}`);
    shutdown(1);
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

if (!shuttingDown) {
  console.log("[serve] engine healthy — starting ayos");
  const server = spawn(process.execPath, [join(import.meta.dirname, "../src/index.js")], {
    stdio: "inherit",
    env: { ...process.env, AYOS_EXTERNAL_ENGINE: "1", RIVET_ENDPOINT: ENGINE_URL },
  });
  children.push(server);
  server.on("exit", (code) => {
    if (!shuttingDown) console.error(`[serve] ayos exited (${code})`);
    shutdown(code ?? 1);
  });
}
