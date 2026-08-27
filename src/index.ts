import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { InProcessJobHost } from "./job/inProcessHost.ts";
import { createSandboxProvider } from "./sandbox/provider.ts";
import { createAgentSessionFactory } from "./agent/provider.ts";

const config = await loadConfig();

const host = new InProcessJobHost({
  sandboxes: createSandboxProvider(),
  agents: createAgentSessionFactory(),
  defaultTimeoutS: config.defaultTimeoutS,
  sharedSecret: config.sharedSecret,
});

const app = createApp({ config, host });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`ayos listening on :${info.port}`);
});
