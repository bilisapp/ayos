import { serve } from "@hono/node-server";
import { loadDotEnv } from "./env.ts";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { InProcessJobHost } from "./job/inProcessHost.ts";
import { createSandboxProvider } from "./sandbox/provider.ts";
import { createAgentSessionFactory } from "./agent/provider.ts";
import { onBeforeVmShutdown } from "./vm/client.ts";

loadDotEnv();
const config = await loadConfig();

const host = new InProcessJobHost({
  sandboxes: createSandboxProvider(),
  agents: createAgentSessionFactory(),
  defaultTimeoutS: config.defaultTimeoutS,
  sharedSecret: config.sharedSecret,
});

// On SIGINT/SIGTERM (every tsx-watch restart is one) the jobs have to unwind
// before the Rivet registry does — a job in flight still holds a VM actor, and
// an actor destroyed by the engine's own teardown loses its final persist.
onBeforeVmShutdown(async (timeoutMs) => {
  const { drained, pending } = await host.drain(timeoutMs);
  if (!drained) console.warn(`shutdown: ${pending} job(s) still running after grace period`);
});

const app = createApp({ config, host });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ayos listening on :${info.port}`);
});
