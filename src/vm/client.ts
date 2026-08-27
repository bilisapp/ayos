import { createClient } from "@rivet-dev/agentos/client";
import { registry } from "./actor.ts";
import type { AgentOsClient } from "../sandbox/agentos.ts";

export const DEFAULT_ENGINE_ENDPOINT = "http://127.0.0.1:6420";

let started: { client: AgentOsClient; shutdown: () => Promise<void> } | null = null;

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
