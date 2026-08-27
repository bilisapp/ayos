import { type JobSpec, type Artifact, type JobState } from "../types.ts";
import type { SandboxProvider, Sandbox } from "../sandbox.ts";
import { egressAllowlistFor, registriesForTestCmd } from "../sandbox.ts";
import type { AgentSessionFactory } from "../agent/session.ts";
import { buildSystemPrompt, buildUserPrompt, randomNonce } from "../agent/prompt.ts";
import { shallowClone, WORKDIR, CloneError } from "../git/clone.ts";
import { packageDiff, runTests, violatesDenylist, type TestRun } from "../artifact/package.ts";
import { makeRedactor } from "../events/redact.ts";
import { truncateText, MAX_TOOL_RESULT_BYTES, type EventType } from "../events/schema.ts";

export interface EmitFn {
  (type: EventType, data: Record<string, unknown>): void;
}

export interface RunnerDeps {
  sandboxes: SandboxProvider;
  agents: AgentSessionFactory;
  /** Called for every event, already redacted. The host buffers and broadcasts. */
  emit: EmitFn;
  /** Called on every state transition, so the host can persist it. */
  onState: (state: JobState) => void;
  defaultTimeoutS: number;
  gitHost?: string;
  llmHost?: string;
  now?: () => number;
}

const EMPTY_DURATIONS = { clone_ms: 0, agent_ms: 0, test_ms: 0 };

/**
 * Where the agent's model calls go. Overridable per job (`llm_host`) and per
 * deployment (`deps.llmHost`) — it is only the fallback, and it is the single
 * place to change if the agent runtime talks to a different endpoint.
 */
export const DEFAULT_LLM_HOST = "api.anthropic.com";

/**
 * Drives one job start to finish. Never throws: every failure path produces an
 * artifact, because the caller is waiting for exactly one of those.
 */
export async function runJob(
  spec: JobSpec,
  deps: RunnerDeps,
  externalSignal?: AbortSignal,
): Promise<Artifact> {
  const now = deps.now ?? Date.now;
  const redactor = makeRedactor([spec.clone_token, spec.llm_key]);
  const timeoutMs = (spec.constraints.timeout_s ?? deps.defaultTimeoutS) * 1000;

  const durations = { ...EMPTY_DURATIONS };
  let state: JobState = "queued";
  let sandbox: Sandbox | null = null;
  let summary = "";
  let diff: string | null = null;
  let filesTouched: string[] = [];
  let tests: TestRun | null = null;

  let terminalReason: "timeout" | "cancelled" | null = null;
  const controller = new AbortController();
  const abortFor = (reason: "timeout" | "cancelled") => {
    if (terminalReason === null) terminalReason = reason;
    controller.abort(reason);
  };

  const onExternalAbort = () => abortFor("cancelled");
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => abortFor("timeout"), timeoutMs);

  const emit: EmitFn = (type, data) =>
    deps.emit(type, redactor.redactValue(data) as Record<string, unknown>);

  const setState = (next: JobState) => {
    state = next;
    deps.onState(next);
    emit("phase", { state: next });
  };

  const finish = (status: Artifact["status"], extra?: { error?: string }): Artifact => {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (extra?.error) emit("error", { message: extra.error });
    setState(status);
    emit("done", { status });
    return {
      job_id: spec.job_id,
      status,
      diff,
      report: {
        summary: redactor.redactString(summary || extra?.error || ""),
        files_touched: filesTouched,
        tests: tests
          ? { cmd: tests.cmd, passed: tests.passed, output_tail: tests.output_tail }
          : spec.constraints.test_cmd
            ? { cmd: spec.constraints.test_cmd, passed: null, output_tail: "" }
            : null,
        durations,
        links: spec.task.links,
      },
      // The host owns the event log (it has the ring buffer); it fills this in.
      events: [],
    };
  };

  try {
    // 1. Provision, with egress narrowed to exactly what this job needs.
    const gitHost = deps.gitHost ?? "github.com";
    const llmHost = spec.llm_host ?? deps.llmHost ?? DEFAULT_LLM_HOST;
    const egress = egressAllowlistFor({
      gitHost,
      llmHost,
      registries: registriesForTestCmd(spec.constraints.test_cmd),
    });
    emit("phase", { state: "queued", egress });
    sandbox = await deps.sandboxes.provision({
      jobId: spec.job_id,
      egressAllowlist: egress,
      signal: controller.signal,
    });

    // 2. Clone at the pinned sha.
    setState("cloning");
    const cloneStart = now();
    try {
      await shallowClone(sandbox, {
        repo: spec.repo,
        baseRef: spec.base_ref,
        baseSha: spec.base_sha,
        cloneToken: spec.clone_token,
        host: gitHost,
        signal: controller.signal,
      });
    } catch (err) {
      if (terminalReason) return finish(terminalReason);
      const detail = err instanceof CloneError ? `${err.message}: ${err.stderr}` : String(err);
      return finish("failed", { error: redactor.redactString(`clone failed — ${detail}`) });
    }
    durations.clone_ms = now() - cloneStart;
    emit("phase", { state: "cloning", done: true, duration_ms: durations.clone_ms });

    // 3. Agent session.
    setState("fixing");
    const nonce = randomNonce();
    const agentStart = now();
    const session = await deps.agents.create({
      sandbox,
      cwd: WORKDIR,
      llmKey: spec.llm_key,
      signal: controller.signal,
    });
    try {
      const result = await session.run({
        systemPrompt: buildSystemPrompt(spec, nonce),
        userPrompt: buildUserPrompt(spec, nonce),
        signal: controller.signal,
        onTurn: (turn) => {
          const data =
            turn.type === "tool_result"
              ? { ...turn.data, output: truncateText(String(turn.data.output ?? ""), MAX_TOOL_RESULT_BYTES) }
              : turn.data;
          emit(turn.type, data);
        },
      });
      summary = result.summary;
    } finally {
      durations.agent_ms = now() - agentStart;
      await session.dispose().catch(() => {});
    }
    if (terminalReason) return finish(terminalReason);

    // 4. Verify.
    if (spec.constraints.test_cmd) {
      setState("testing");
      tests = await runTests(sandbox, spec.constraints.test_cmd, { signal: controller.signal });
      durations.test_ms = tests.durationMs;
      emit("test_output", { passed: tests.passed, output_tail: tests.output_tail });
      if (terminalReason) return finish(terminalReason);
    }

    // 5. Package.
    setState("packaging");
    const packaged = await packageDiff(sandbox, spec.base_sha, spec.constraints.max_diff_lines);
    diff = packaged.diff || null;
    filesTouched = packaged.filesTouched;

    // The agent was told the denylist; this is the check that it obeyed.
    const violations = violatesDenylist(filesTouched, spec.constraints.path_denylist);
    if (violations.length) {
      diff = null;
      return finish("failed", {
        error: `agent touched denylisted paths: ${violations.join(", ")}`,
      });
    }
    if (packaged.truncated) {
      return finish("failed", {
        error: `diff exceeds max_diff_lines (${packaged.lineCount} > ${spec.constraints.max_diff_lines})`,
      });
    }

    return finish("done");
  } catch (err) {
    if (terminalReason) return finish(terminalReason);
    return finish("failed", {
      error: redactor.redactString(err instanceof Error ? err.message : String(err)),
    });
  } finally {
    clearTimeout(timer);
    // 7. Dispose. Nothing persists in Ayos beyond actor state.
    await sandbox?.dispose().catch(() => {});
    void state;
  }
}
