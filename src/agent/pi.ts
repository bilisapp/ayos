import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionFactory, AgentTurn, AgentResult } from "./session.ts";

/** The providers a job may authenticate against. */
export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** The provider a spec means when it does not say. */
export const PROVIDER_ID: ProviderId = "anthropic";

/**
 * What each provider needs to be reached: which wire API it speaks, where it
 * lives, and which model a job runs on there.
 *
 * The model is per provider because the same weights have a different id at
 * each one — `claude-sonnet-5` at Anthropic is `anthropic/claude-sonnet-5` at
 * OpenRouter — and a job that picked the wrong one would fail at the first
 * request rather than at the first line of code. AYOS_PI_MODEL still overrides
 * it, for an operator who knows exactly what they want.
 */
export const PROVIDERS: Record<
  ProviderId,
  { api: "anthropic-messages" | "openai-responses" | "openai-completions"; host: string; model: string }
> = {
  anthropic: { api: "anthropic-messages", host: "api.anthropic.com", model: "claude-sonnet-5" },
  openai: { api: "openai-responses", host: "api.openai.com", model: "gpt-5.3-codex" },
  openrouter: {
    api: "openai-completions",
    host: "openrouter.ai",
    model: "anthropic/claude-sonnet-5",
  },
};

/** The model an Anthropic job runs on unless AYOS_PI_MODEL says otherwise. */
export const DEFAULT_PI_MODEL = PROVIDERS.anthropic.model;

export const DEFAULT_LLM_HOST = PROVIDERS.anthropic.host;

/**
 * The agent's toolset. Explicit, because Pi's default is `read`/`bash`/`edit`/
 * `write` and the search tools make the difference between an agent that reads
 * the repository and one that greps it. There is nothing here that publishes.
 */
export const AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/** Text out of a pi message, whatever shape its content blocks arrived in. */
function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      Boolean(b && typeof b === "object" && (b as { type?: unknown }).type === "text"),
    )
    .map((b) => b.text ?? "")
    .join("");
}

function isAssistant(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  const text = textOf(result);
  if (text) return text;
  if (result && typeof result === "object" && "output" in result)
    return String((result as { output: unknown }).output ?? "");
  try {
    return JSON.stringify(result) ?? "";
  } catch {
    return String(result);
  }
}

/**
 * Drives Pi in-process through its SDK.
 *
 * Everything about this run is in memory and scoped to it: credentials in an
 * `InMemoryCredentialStore`, the session in `SessionManager.inMemory()`,
 * settings in `SettingsManager.inMemory()`, and `agentDir` pointed at a fresh
 * temp directory rather than `~/.pi/agent`. No key, transcript or setting
 * touches a path that outlives the container, and nothing on the host machine
 * can steer the agent by leaving a file in a well-known place.
 *
 * The resource loader is deliberately blinkered — `noExtensions`, `noSkills`,
 * `noPromptTemplates`, `noThemes`, `noContextFiles`. Pi's normal behaviour is
 * to discover `AGENTS.md`, `.pi/skills/*` and extensions **from the working
 * directory**, and the working directory here is a repository we are treating
 * as untrusted. Left on, a file in the cloned repo would write part of the
 * system prompt — the exact injection the fence in `prompt.ts` exists to stop.
 */
export class PiSession implements AgentSession {
  private disposed = false;

  constructor(
    private readonly session: import("@earendil-works/pi-coding-agent").AgentSession,
    private readonly agentDir: string,
  ) {}

  /**
   * The prompt the model will actually receive. Exposed so a test can prove
   * that what Pi assembled is what we handed it — the repository's own
   * `AGENTS.md` and `.pi/skills` must not be able to write into it.
   */
  get systemPrompt(): string {
    return this.session.systemPrompt;
  }

  async run(opts: {
    userPrompt: string;
    onTurn: (turn: AgentTurn) => void;
    signal?: AbortSignal;
  }): Promise<AgentResult> {
    let summary = "";
    let stopped = false;

    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "agent_end") {
        // The closing assistant message is the agent's own summary, and it is
        // what `report.summary` carries back to the caller.
        const text = summaryOf(event.messages);
        if (text) summary = text;
        return;
      }
      const turn = toTurn(event);
      if (turn) opts.onTurn(turn);
    });

    const onAbort = () => {
      stopped = true;
      void this.session.abort().catch(() => {});
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.session.prompt(opts.userPrompt, { expandPromptTemplates: false });
    } catch (err) {
      // An aborted run surfaces here as a rejection; that is a cancellation,
      // not an agent failure, and the runner's terminal reason already says so.
      if (!opts.signal?.aborted) throw err;
      stopped = true;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
    }

    return { summary, stopped: stopped || Boolean(opts.signal?.aborted) };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.session.dispose();
    } catch {
      /* a session that never opened has nothing to close */
    }
    await rm(this.agentDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Pi's session events, mapped onto the transcript the caller persists.
 *
 * Deliberately partial. `message_update` and `bash_execution_update` are
 * per-token deltas: events are batched to the caller now rather than streamed
 * frame by frame, so the COMPLETED message is what gets shipped and the deltas
 * are dropped. `agent_end` is handled separately — it is the summary, not a
 * transcript entry.
 */
export function toTurn(event: { type: string } & Record<string, unknown>): AgentTurn | null {
  switch (event.type) {
    case "message_end": {
      if (!isAssistant(event.message)) return null;
      const text = textOf(event.message);
      return text.trim() ? { type: "agent_message", data: { text } } : null;
    }
    case "tool_execution_start":
      return {
        type: "tool_call",
        data: {
          tool_call_id: event.toolCallId,
          name: event.toolName,
          title: event.toolName,
          input: event.args,
        },
      };
    case "tool_execution_end":
      return {
        type: "tool_result",
        data: {
          tool_call_id: event.toolCallId,
          name: event.toolName,
          status: event.isError ? "failed" : "completed",
          output: stringifyResult(event.result),
        },
      };
    default:
      return null;
  }
}

/** The agent's closing words: the last assistant message of the run. */
export function summaryOf(messages: readonly unknown[]): string {
  const last = [...messages].reverse().find(isAssistant);
  const text = textOf(last);
  return text.trim() ? text : "";
}

export class PiSessionFactory implements AgentSessionFactory {
  async create(opts: {
    cwd: string;
    llmProvider?: ProviderId;
    llmKey: string;
    llmHost?: string;
    systemPrompt: string;
    signal?: AbortSignal;
  }): Promise<AgentSession> {
    const agentDir = await mkdtemp(join(tmpdir(), "ayos-agent-"));
    const providerId = opts.llmProvider ?? PROVIDER_ID;
    const provider = PROVIDERS[providerId];
    const modelId = process.env.AYOS_PI_MODEL ?? provider.model;

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      // No auth.json, no models.json, and no catalog fetch at startup: the
      // bundled static catalog is enough, and a run must never block or fail
      // on a network call made before the agent has done anything.
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
      signal: opts.signal,
    });

    // A caller routing model traffic somewhere other than the provider's own
    // host re-registers it at that base URL. The catalog entries stay; only
    // where the requests go changes.
    if (opts.llmHost && opts.llmHost !== provider.host) {
      modelRuntime.registerProvider(providerId, {
        baseUrl: `https://${opts.llmHost}`,
        apiKey: opts.llmKey,
        api: provider.api,
      });
    }
    await modelRuntime.setRuntimeApiKey(providerId, opts.llmKey);

    const model = modelRuntime.getModel(providerId, modelId);
    if (!model) {
      const known = modelRuntime
        .getModels(providerId)
        .map((m) => m.id)
        .join(", ");
      throw new Error(
        `model ${modelId} is not in the ${providerId} catalog (have: ${known}). ` +
          `Set AYOS_PI_MODEL to one of those, or pin a newer SDK.`,
      );
    }

    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir,
      settingsManager,
      systemPrompt: opts.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: opts.cwd,
      agentDir,
      model,
      modelRuntime,
      tools: [...AGENT_TOOLS],
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(opts.cwd),
    });

    return new PiSession(session, agentDir);
  }
}
