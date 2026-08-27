import { createClient } from "@rivet-dev/agentos/client";
import { registry } from "./actor.ts";
import type { AgentOsClient } from "../sandbox/agentos.ts";

export const DEFAULT_ENGINE_ENDPOINT = "http://127.0.0.1:6420";

/**
 * How long the pre-shutdown tasks get, in total, before we stop waiting and
 * take the registry down anyway. Long enough for a cancelled job to unwind and
 * destroy its VM, short enough that a tsx-watch restart still feels instant.
 */
const SHUTDOWN_GRACE_MS = 5000;

let started: { client: AgentOsClient; shutdown: () => Promise<void> } | null = null;

/** Registered here rather than passed in: the signal handlers are installed by
 * whoever boots the runtime first (the sandbox provider), which is earlier than
 * the entrypoint has a job host to hand over. */
const preShutdown: Array<(timeoutMs: number) => Promise<unknown>> = [];

/**
 * Runs before `registry.shutdown()`. Use it for anything that owns a live
 * actor — the actor has to be destroyed by us, and finish its own stop-persist,
 * while the engine is still up.
 */
export function onBeforeVmShutdown(task: (timeoutMs: number) => Promise<unknown>): void {
  preShutdown.push(task);
}

/**
 * Boots the Rivet registry (which spawns the bundled engine) and returns a
 * client for it.
 *
 * `registry.start()` leaks the engine child process if the node process exits
 * without `shutdown()`, and a stale engine on the port poisons the next run —
 * hence the signal handlers.
 */
export function startVmRuntime(): { client: AgentOsClient; shutdown: () => Promise<void> } {
  if (started) return started;

  registry.start();

  const client = createClient({
    endpoint: process.env.RIVET_ENDPOINT ?? DEFAULT_ENGINE_ENDPOINT,
  }) as unknown as AgentOsClient;

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Order matters. Shutting the registry down under a live actor closes that
    // actor's SQLite transaction coordinator while its final state persist is
    // still in flight ("transaction_closed" / "actor stop failed after
    // asynchronous completion handoff"). Let the owners destroy their actors
    // first; only then take the engine away.
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    for (const task of preShutdown) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await task(remaining).catch(() => {});
    }
    await registry.shutdown().catch(() => {});
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }

  started = { client, shutdown };
  return started;
}
