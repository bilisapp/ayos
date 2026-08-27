import type { Sandbox } from "../sandbox.ts";
import type { EventType } from "../events/schema.ts";

/**
 * What the lifecycle needs from a coding agent. agentOS drives Claude Code over
 * JSON-RPC/stdio; this interface is what that adapter must satisfy, and what a
 * fake satisfies in tests.
 */
export interface AgentTurn {
  type: Extract<EventType, "agent_message" | "tool_call" | "tool_result" | "error">;
  data: Record<string, unknown>;
}

export interface AgentResult {
  /** The agent's closing explanation, used as `report.summary`. */
  summary: string;
  /** True when the agent reported it could not complete the task. */
  stopped: boolean;
}

export interface AgentSession {
  /** Yields turns as they happen so the actor can stream them. */
  run(opts: {
    systemPrompt: string;
    userPrompt: string;
    onTurn: (turn: AgentTurn) => void;
    signal?: AbortSignal;
  }): Promise<AgentResult>;
  dispose(): Promise<void>;
}

export interface AgentSessionFactory {
  create(opts: {
    sandbox: Sandbox;
    cwd: string;
    llmKey: string;
    signal?: AbortSignal;
  }): Promise<AgentSession>;
}
