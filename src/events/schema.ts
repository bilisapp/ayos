export const EVENT_TYPES = [
  "phase",
  "agent_message",
  "tool_call",
  "tool_result",
  "test_output",
  "error",
  "done",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface JobEvent {
  seq: number;
  ts: string;
  type: EventType;
  data: Record<string, unknown>;
  durability?: "durable";
}

/**
 * Live-only event forwarded to connected viewers. It is intentionally not put
 * in the replay ring or the final artifact, matching agentOS's ephemeral
 * session deltas.
 */
export interface EphemeralJobEvent {
  durability: "ephemeral";
  ts: string;
  type: EventType;
  data: Record<string, unknown>;
}

export type JobStreamEvent = JobEvent | EphemeralJobEvent;

/** tool_result payloads can be huge; the spec caps them at ~4 KB. */
export const MAX_TOOL_RESULT_BYTES = 4096;

export function truncateText(text: string, max = MAX_TOOL_RESULT_BYTES): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
