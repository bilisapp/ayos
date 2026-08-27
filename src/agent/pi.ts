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

    await this.configureModel();

    await vm.sessions.open({
      sessionId: this.sessionId,
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
