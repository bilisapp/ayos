import type { EventType } from "../events/schema.ts";
import type { ProviderId } from "./pi.ts";

/**
 * What the lifecycle needs from a coding agent. The real implementation drives
 * Pi in-process through its SDK; this interface is what that adapter must
 * satisfy, and what a fake satisfies in tests.
 */
export interface AgentTurn {
  type: Extract<EventType, "agent_message" | "tool_call" | "tool_result" | "error">;
  data: Record<string, unknown>;
}

export interface AgentResult {
  /** The agent's closing explanation, used as `report.summary`. */
  summary: string;
  /** True when the run was cut short rather than finishing on its own. */
  stopped: boolean;
}

export interface AgentSession {
  /**
   * Yields turns as they happen so the runner can ship them. The system prompt
   * belongs to `create()`: the SDK takes it once, when the session is built.
   */
  run(opts: {
    userPrompt: string;
    onTurn: (turn: AgentTurn) => void;
    signal?: AbortSignal;
  }): Promise<AgentResult>;
  dispose(): Promise<void>;
}

export interface AgentSessionFactory {
  create(opts: {
    /** The checkout. The agent's tools are rooted here. */
    cwd: string;
    /** Which provider the key authenticates against. Defaults to Anthropic. */
    llmProvider?: ProviderId;
    llmKey: string;
    /** Host override, when the caller routes model traffic through its own. */
    llmHost?: string;
    /**
     * The safety invariants. Pi's SDK takes a real system prompt — the ACP
     * adapter did not, which is why these used to ride in the first user turn.
     */
    systemPrompt: string;
    signal?: AbortSignal;
  }): Promise<AgentSession>;
}
