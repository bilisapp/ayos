import type { SandboxProvider } from "../sandbox.ts";
import { AgentOsSandboxProvider } from "./agentos.ts";
import { startVmRuntime } from "../vm/client.ts";

export function createSandboxProvider(): SandboxProvider {
  const { client } = startVmRuntime();
  return new AgentOsSandboxProvider({
    client,
    // Set AYOS_SKIP_EGRESS_CHECK=1 only for local work against a VM you trust;
    // in production a silently-unenforced allowlist must fail the job.
    verifyEgress: process.env.AYOS_SKIP_EGRESS_CHECK !== "1",
  });
}
