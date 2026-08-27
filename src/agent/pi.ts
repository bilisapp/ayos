import type { AgentSession, AgentSessionFactory, AgentTurn, AgentResult } from "./session.ts";
import type { Sandbox } from "../sandbox.ts";
import { AgentOsSandbox } from "../sandbox/agentos.ts";

export const PI_AGENT_ID = "pi";

/**
 * The model every job runs on unless AYOS_PI_MODEL says otherwise. Pi's
 * bundled registry may predate this id, so it is also registered as a custom
 * model in the VM's models.json (see configureModel) rather than merely named
 * in settings — an id the registry cannot resolve silently falls back to Pi's
 * own default, which is exactly the surprise we're avoiding.
 */
export const DEFAULT_PI_MODEL = "claude-sonnet-5";

/** A `sessionEvent` row as emitted by agentOS's normalized session stream. */
interface SessionStreamEntry {
  durability?: "durable" | "ephemeral";
  sessionId?: string;
  sequence?: number;
  afterSequence?: number;
  timestamp?: string;
  type?: string;
  content?: unknown;
  messageId?: string | null;
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

/**
 * The one session every job uses. agentOS defaults to "main" when no
 * sessionId is given, and its event fan-out is keyed by EXACT session id:
 * the wrapper subscribes under the id passed to open/prompt, while the ACP
 * sidecar tags events with its own notion of the session's id. Naming the
 * session after the job put those two out of agreement and silently dropped
 * every sessionEvent broadcast. The VM is one-job/one-session, so the
 * documented default is the only id we ever need.
 */
const SESSION_ID = "main";

export class PiSession implements AgentSession {
  private unsubscribe: (() => void) | null = null;
  private opened = false;
  private readonly messageDeltas = new Map<string, string>();

  constructor(
    private readonly sandbox: AgentOsSandbox,
    private readonly jobId: string,
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

    await this.configureModel();

    // Register the local actor-event listener before opening the session. The
    // VM is one-job/one-session, so do not filter by `sessionId`: older
    // agentOS/Pi combinations can surface the adapter/private ID here while the
    // public ID is still the one used for actions and history.
    this.unsubscribe = conn.on("sessionEvent", (payload: unknown) => {
      const turn = toTurn(payload as SessionStreamEntry, this.messageDeltas);
      if (turn) opts.onTurn(turn);
    });

    await vm.sessions.open({
      sessionId: SESSION_ID,
      agent: PI_AGENT_ID,
      // model: "claude-sonnet-5",
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

    const onAbort = () => {
      void vm.sessions.cancelPrompt({ sessionId: SESSION_ID }).catch(() => {});
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await vm.sessions.prompt({
        sessionId: SESSION_ID,
        // Ayos generates one prompt per job, so the job id is a natural
        // idempotency key: a retried prompt returns the same message rather
        // than paying for a second run.
        idempotencyKey: this.jobId,
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

  /**
   * Pin the model before the session opens.
   *
   * Pi reads `~/.pi/agent/settings.json` for its default provider/model and
   * merges `~/.pi/agent/models.json` into its registry (custom entries win).
   * We write both: settings alone would silently fall back to Pi's bundled
   * default whenever the bundled registry predates the requested id, and
   * models.json requires the provider's baseUrl + apiKey when it defines
   * models — both of which the session already holds in env.
   */
  private async configureModel(): Promise<void> {
    const model = process.env.AYOS_PI_MODEL ?? DEFAULT_PI_MODEL;
    const apiKey = this.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const baseUrl = this.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
    const agentDir = "/home/agentos/.pi/agent";
    const { vm } = this.sandbox;

    await vm.mkdir(agentDir, { recursive: true });
    await vm.writeFile(
      `${agentDir}/settings.json`,
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: model }),
    );
    await vm.writeFile(
      `${agentDir}/models.json`,
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl,
            apiKey,
            api: "anthropic-messages",
            models: [
              {
                id: model,
                name: model,
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 200_000,
                maxTokens: 64_000,
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              },
            ],
          },
        },
      }),
    );
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.opened) {
      await this.sandbox.vm.sessions.delete({ sessionId: SESSION_ID }).catch(() => {});
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

function messageStreamId(entry: SessionStreamEntry): string {
  if (entry.messageId) return `agent-message:${entry.messageId}`;
  if (typeof entry.afterSequence === "number") return `agent-message:after-${entry.afterSequence}`;
  if (typeof entry.sequence === "number") return `agent-message:sequence-${entry.sequence}`;
  return "agent-message:current";
}

function toTurn(entry: SessionStreamEntry, messageDeltas: Map<string, string>): AgentTurn | null {
  switch (entry.type) {
    case "agent_message_chunk": {
      const streamId = messageStreamId(entry);
      const chunk = textOf(entry.content);
      const text =
        entry.durability === "ephemeral"
          ? `${messageDeltas.get(streamId) ?? ""}${chunk}`
          : chunk;

      if (entry.durability === "ephemeral") messageDeltas.set(streamId, text);
      // A durable chunk commits the whole message, so every accumulated delta
      // is stale — including ones filed under a different key, since the
      // ephemeral and durable copies of one message do not always agree on
      // messageId/afterSequence. One prompt runs at a time, so clearing all
      // of them can only drop text that was already superseded; deleting only
      // this key left the old message's text to be prepended to the next one.
      else messageDeltas.clear();

      return {
        type: "agent_message",
        durability: entry.durability,
        data: {
          text,
          stream_id: streamId,
          session_sequence: entry.sequence,
          after_session_sequence: entry.afterSequence,
        },
      };
    }
    case "agent_thought_chunk":
      // Thinking is not shown to viewers — it is noisy and can echo the context.
      return null;
    case "tool_call":
      return {
        type: "tool_call",
        durability: entry.durability,
        data: {
          tool_call_id: entry.toolCallId,
          title: entry.title,
          name: entry.title,
          status: entry.status,
          input: entry.rawInput,
          session_sequence: entry.sequence,
        },
      };
    case "tool_call_update":
      // Only the terminal update matters for a transcript; the in-progress ones
      // repeat the same call with partial output.
      if (entry.status !== "completed" && entry.status !== "failed") return null;
      return {
        type: "tool_result",
        durability: entry.durability,
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
          session_sequence: entry.sequence,
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
