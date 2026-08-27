import type { AgentSessionFactory } from "./session.ts";
import { PiSessionFactory } from "./pi.ts";

export function createAgentSessionFactory(): AgentSessionFactory {
  return new PiSessionFactory();
}
