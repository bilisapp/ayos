import { type JobSpec, type Artifact, type JobState } from "../types.ts";
import type { AgentSessionFactory } from "../agent/session.ts";
import { buildSystemPrompt, buildUserPrompt, randomNonce } from "../agent/prompt.ts";
import { shallowClone, CloneError, type Checkout } from "../git/clone.ts";
import { revokeCloneToken, type RevokeResult } from "../git/revoke.ts";
import {
  packageDiff,
  runTests,
  violatesDenylist,
  requiredToolFor,
  type TestRun,
} from "../artifact/package.ts";
import { exec } from "../exec.ts";
import { makeRedactor } from "../events/redact.ts";
import { truncateText, MAX_TOOL_RESULT_BYTES, type EventType } from "../events/schema.ts";

export interface EmitFn {
  (type: EventType, data: Record<string, unknown>): void;
}

export interface RunnerDeps {
  agents: AgentSessionFactory;
  /** Called for every event, already redacted. The caller batches and ships them. */
  emit: EmitFn;
  /** Called on every state transition. */
  onState: (state: JobState) => void;
  defaultTimeoutS: number;
  gitHost?: string;
  /** Injectable so a test never talks to GitHub. */
  revoke?: (token: string) => Promise<RevokeResult>;
  now?: () => number;
}

const EMPTY_DURATIONS = { clone_ms: 0, agent_ms: 0, test_ms: 0 };

/**
 * Drives one job start to finish. Never throws: every failure path produces an
 * artifact, because the caller is waiting for exactly one of those.
 *
 * The phase machine is unchanged from the VM design — clone, agent, test,
 * package, deliver — but the containment underneath it is not. There is no VM
 * and no egress allowlist: the whole container is the sandbox, single-tenant
 * and thrown away at the end of this one job. What survives is everything that
 * protects the OUTPUT rather than the host: the diff is computed by us and not
 * by the agent, `.git` is treated as hostile, the denylist and line cap are
 * enforced after the fact, and nothing here can push.
 */
export async function runJob(
  spec: JobSpec,
  deps: RunnerDeps,
  externalSignal?: AbortSignal,
): Promise<Artifact> {
  const now = deps.now ?? Date.now;
  const redactor = makeRedactor([spec.clone_token, spec.llm_key, spec.signing_key]);
  const timeoutMs = (spec.constraints.timeout_s ?? deps.defaultTimeoutS) * 1000;
  const revoke = deps.revoke ?? ((token: string) => revokeCloneToken(token));

  const durations = { ...EMPTY_DURATIONS };
  let state: JobState = "queued";
  let checkout: Checkout | null = null;
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
  const deadline = now() + timeoutMs;
  /** What is left of the job budget, as a hard per-command cap. Never zero. */
  const remainingMs = () => Math.max(1_000, deadline - now());
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
        error: extra?.error ? redactor.redactString(extra.error) : null,
        files_touched: filesTouched,
        tests: tests
          ? { cmd: tests.cmd, passed: tests.passed, output_tail: tests.output_tail }
          : spec.constraints.test_cmd
            ? { cmd: spec.constraints.test_cmd, passed: null, output_tail: "" }
            : null,
        durations,
        links: spec.task.links,
      },
      // Filled in by the entrypoint, which owns the event log.
      events: [],
    };
  };

  try {
    // 1. Clone. Still the first thing that happens, and still with the token
    //    delivered through a one-shot GIT_ASKPASS script rather than argv or
    //    .git/config.
    setState("cloning");
    try {
      checkout = await shallowClone({
        repo: spec.repo,
        baseRef: spec.base_ref,
        baseSha: spec.base_sha,
        cloneToken: spec.clone_token,
        host: deps.gitHost ?? "github.com",
        signal: controller.signal,
      });
    } catch (err) {
      if (terminalReason) return finish(terminalReason);
      const detail = err instanceof CloneError ? `${err.message}: ${err.stderr}` : String(err);
      return finish("failed", { error: redactor.redactString(`clone failed — ${detail}`) });
    }
    durations.clone_ms = checkout.durationMs;
    emit("phase", { state: "cloning", done: true, duration_ms: durations.clone_ms });

    // 2. Kill the clone token, before the agent exists.
    //
    //    The VM design kept the token out of the sandbox entirely. One
    //    container per job cannot: the agent's `bash` runs beside this code.
    //    Revocation replaces isolation with time — by the agent's first tool
    //    call the credential is already dead. Best effort: the token is
    //    `contents: read` on one repository and expires within the hour
    //    regardless, so a failed revocation is reported, not fatal.
    const revocation = await revoke(spec.clone_token);
    emit("phase", {
      state: "cloning",
      token_revoked: revocation.revoked,
      ...(revocation.revoked ? {} : { revoke_status: revocation.status, revoke_error: revocation.error }),
    });

    // The image carries git and node, not language runtimes. Fail here, plainly,
    // rather than letting the caller read "tests failed" and go hunting.
    if (spec.constraints.test_cmd) {
      const tool = requiredToolFor(spec.constraints.test_cmd);
      if (tool) {
        const probe = await exec("sh", ["-lc", `command -v ${tool}`], {
          timeoutMs: Math.min(30_000, remainingMs()),
          signal: controller.signal,
        });
        if (probe.exitCode !== 0)
          return finish("failed", {
            error:
              `test_cmd requires \`${tool}\`, which is not installed in the runner image. ` +
              `Set test_cmd to null and run tests in your CI instead.`,
          });
      }
    }

    // 3. Agent session, rooted in the checkout.
    setState("fixing");
    const nonce = randomNonce();
    const agentStart = now();
    const session = await deps.agents.create({
      cwd: checkout.hostPath,
      llmProvider: spec.llm_provider,
      llmKey: spec.llm_key,
      llmHost: spec.llm_host,
      // A real system prompt at last: Pi's SDK takes one, where its ACP adapter
      // silently dropped `additionalInstructions`. The invariants no longer
      // have to masquerade as the opening of the first user turn.
      systemPrompt: buildSystemPrompt(spec, nonce),
      signal: controller.signal,
    });
    try {
      const result = await session.run({
        userPrompt: buildUserPrompt(spec, nonce),
        signal: controller.signal,
        onTurn: (turn) => {
          const data =
            turn.type === "tool_result"
              ? {
                  ...turn.data,
                  output: truncateText(String(turn.data.output ?? ""), MAX_TOOL_RESULT_BYTES),
                }
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
      // The job-level timer aborts the run, but the command needs its own cap
      // too: `exec` kills the process GROUP, so a suite that forks cannot
      // outlive the budget by detaching from the shell that started it.
      tests = await runTests(checkout.hostPath, spec.constraints.test_cmd, {
        timeoutMs: remainingMs(),
        signal: controller.signal,
      });
      durations.test_ms = tests.durationMs;
      emit("test_output", { passed: tests.passed, output_tail: tests.output_tail });
      if (terminalReason) return finish(terminalReason);
    }

    // 5. Package.
    setState("packaging");
    const packaged = await packageDiff(
      checkout.hostPath,
      spec.base_sha,
      spec.constraints.max_diff_lines,
    );
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
    // The container is about to exit, but the checkout still holds the repo and
    // an aborted run may not reach that exit promptly — delete it here.
    await checkout?.cleanup().catch(() => {});
    void state;
  }
}
