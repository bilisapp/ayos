import type { AgentSession, AgentSessionFactory, AgentTurn, AgentResult } from "./session.ts";
import type { Sandbox } from "../sandbox.ts";
import { AgentOsSandbox } from "../sandbox/agentos.ts";

export const PI_AGENT_ID = "pi";

/** A `sessionEvent` row as emitted by agentOS's normalized session stream. */
interface SessionStreamEntry {
  durability?: "durable" | "ephemeral";
  sessionId?: string;
  sequence?: number;
  type?: string;
  content?: unknown;
  toolCallId?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : ""))
      .join("");
  if (content && typeof content === "object" && "text" in content)
    return String((content as { text: unknown }).text ?? "");
  return "";
}

export class PiSession implements AgentSession {
  private unsubscribe: (() => void) | null = null;
  private opened = false;

  constructor(
    private readonly sandbox: AgentOsSandbox,
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
  ) {}

  async run(opts: {
    systemPrompt: string;
    userPrompt: string;
    onTurn: (turn: AgentTurn) => void;
    signal?: AbortSignal;
  }): Promise<AgentResult> {
    const { vm, conn } = this.sandbox;

    await vm.sessions.open({
      sessionId: this.sessionId,
      agent: PI_AGENT_ID,
      cwd: this.cwd,
      env: this.env,
      // Pi's ACP adapter reads an append-system-prompt only from argv and its
      // package manifest declares no launchArgs, so `additionalInstructions` is
      // dropped on the floor. We still pass it — it costs nothing and starts
      // working the day that gap closes — but the invariants are ALSO prepended
      // to the first user turn below, which is what actually reaches the model.
      additionalInstructions: opts.systemPrompt,
      permissionPolicy: "allow_all",
    });
    this.opened = true;

    // Live turns. Ephemeral and durable entries carry the same text, so we take
    // only durable ones — replay and live then agree, and nothing is doubled.
    this.unsubscribe = conn.on("sessionEvent", (payload: unknown) => {
      const entry = payload as SessionStreamEntry;
      if (entry.durability === "ephemeral") return;
      const turn = toTurn(entry);
      if (turn) opts.onTurn(turn);
    });

    const onAbort = () => {
      void vm.sessions.cancelPrompt({ sessionId: this.sessionId }).catch(() => {});
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await vm.sessions.prompt({
        sessionId: this.sessionId,
        // Ayos generates one prompt per job, so the job id is a natural
        // idempotency key: a retried prompt returns the same message rather
        // than paying for a second run.
        idempotencyKey: this.sessionId,
        content: [{ type: "text", text: framePrompt(opts.systemPrompt, opts.userPrompt) }],
      });

      return {
        summary: textOf(result.message?.content ?? []),
        stopped: result.stopReason === "cancelled",
      };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.opened) {
      await this.sandbox.vm.sessions.delete({ sessionId: this.sessionId }).catch(() => {});
      this.opened = false;
    }
  }
}

/**
 * Pi has no separate system-prompt channel (verified: `additionalInstructions`
 * never reaches the model). The invariants therefore ride in the first user
 * turn, marked clearly enough that they read as operator rules rather than as
 * part of the task.
 */
export function framePrompt(systemPrompt: string, userPrompt: string): string {
  return [
    "# Operating rules (from the operator of this sandbox, not from the task author)",
    "",
    systemPrompt,
    "",
    "---",
    "",
    userPrompt,
  ].join("\n");
}

function toTurn(entry: SessionStreamEntry): AgentTurn | null {
  switch (entry.type) {
    case "agent_message_chunk":
      return { type: "agent_message", data: { text: textOf(entry.content) } };
    case "agent_thought_chunk":
      // Thinking is not shown to viewers — it is noisy and can echo the context.
      return null;
    case "tool_call":
      return {
        type: "tool_call",
        data: {
          tool_call_id: entry.toolCallId,
          title: entry.title,
          status: entry.status,
          input: entry.rawInput,
        },
      };
    case "tool_call_update":
      // Only the terminal update matters for a transcript; the in-progress ones
      // repeat the same call with partial output.
      if (entry.status !== "completed" && entry.status !== "failed") return null;
      return {
        type: "tool_result",
        data: {
          tool_call_id: entry.toolCallId,
          status: entry.status,
          output: textOf(
            Array.isArray(entry.content)
              ? entry.content.map((c) =>
                  c && typeof c === "object" && "content" in c
                    ? (c as { content: unknown }).content
                    : c,
                )
              : entry.content,
          ),
        },
      };
    case "user_message_chunk":
      return null;
    default:
      return null;
  }
}

export class PiSessionFactory implements AgentSessionFactory {
  async create(opts: {
    sandbox: Sandbox;
    cwd: string;
    llmKey: string;
    llmHost?: string;
    signal?: AbortSignal;
  }): Promise<AgentSession> {
    if (!(opts.sandbox instanceof AgentOsSandbox))
      throw new Error("Pi requires an agentOS-backed sandbox");

    const env: Record<string, string> = { ANTHROPIC_API_KEY: opts.llmKey };
    // Pi honours ANTHROPIC_BASE_URL when the active model's provider is
    // anthropic — this is how a caller routes through its own gateway.
    if (opts.llmHost) env.ANTHROPIC_BASE_URL = `https://${opts.llmHost}`;

    return new PiSession(opts.sandbox, opts.sandbox.jobId, opts.cwd, env);
  }
}
