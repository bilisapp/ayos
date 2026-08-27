/**
 * One-command local dev: starts the Rivet engine, waits for it to actually be
 * healthy, then starts Ayos against it.
 *
 * rivetkit 2.3.9 can start the engine itself, but its health check gives up
 * before the engine finishes booting on macOS arm64, leaving the process
 * retrying "failed to fetch metadata" forever. Running the engine as a separate
 * supervised process avoids that entirely.
 *
 *   pnpm dev
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ENGINE_URL = process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6420";
const require = createRequire(import.meta.url);

function engineBinary(): string {
  const pkg = `@rivetkit/engine-cli-${process.platform}-${process.arch}`;
  try {
    const dir = join(require.resolve(`${pkg}/package.json`), "..");
    const bin = join(dir, "rivet-engine");
    if (existsSync(bin)) return bin;
  } catch {
    // fall through to the clearer error below
  }
  throw new Error(
    `could not find the rivet engine binary (${pkg}). Run 'pnpm install', or start an engine ` +
      `yourself and set RIVET_ENDPOINT.`,
  );
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForEngine(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`engine did not become healthy at ${ENGINE_URL} within ${timeoutMs / 1000}s`);
}

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // A leaked engine on :6420 from a previous run poisons the next one, so this
  // matters more than it looks.
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => shutdown(0));

if (await healthy()) {
  console.log(`[dev] reusing engine already running at ${ENGINE_URL}`);
} else {
  console.log("[dev] starting rivet engine…");
  const engine = spawn(engineBinary(), ["start"], { stdio: ["ignore", "inherit", "inherit"] });
  children.push(engine);
  engine.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[dev] engine exited unexpectedly (${code})`);
      shutdown(1);
    }
  });
  await waitForEngine();
  console.log("[dev] engine healthy");
}

console.log("[dev] starting ayos…");
const server = spawn(
  process.execPath,
  [require.resolve("tsx/cli"), "watch", "--clear-screen=false", "src/index.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, AYOS_EXTERNAL_ENGINE: "1", RIVET_ENDPOINT: ENGINE_URL },
  },
);
children.push(server);
server.on("exit", (code) => shutdown(code ?? 0));
