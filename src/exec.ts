import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Hard cap. The process group is killed when it elapses — never advisory. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Cap on captured output per stream. Beyond it, the head is kept. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the command was killed by the timeout or an abort. */
  killed: boolean;
}

/** 8 MB per stream. A test suite that prints more than that is already lost. */
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Runs a command to completion. Never throws on a non-zero exit — inspect
 * `exitCode`, because a failing test suite is a result, not an error.
 *
 * The child is spawned into its OWN PROCESS GROUP (`detached: true`) and the
 * timeout kills the group, not the pid. `sh -lc "vendor/bin/pest"` is a shell
 * that forks: killing only the shell leaves the suite running with the job's
 * repo and credentials in its environment, holding the container open until the
 * platform's own wall clock stops it.
 *
 * SIGTERM first, then SIGKILL after a grace period, because a test runner that
 * traps SIGTERM to write a report deserves the chance to.
 */
export async function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const capture = (into: "out" | "err") => (chunk: Buffer) => {
      const current = into === "out" ? stdout : stderr;
      if (current.length >= maxOutput) return;
      const text = chunk.toString("utf8").slice(0, maxOutput - current.length);
      if (into === "out") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", capture("out"));
    child.stderr?.on("data", capture("err"));

    /** Kill the whole group; the negative pid is the point. */
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // Already gone, or never became a group leader — try the pid alone.
        try {
          child.kill(sig);
        } catch {
          /* nothing left to kill */
        }
      }
    };

    const terminate = () => {
      if (settled) return;
      killed = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
      killTimer.unref?.();
    };

    const timer = opts.timeoutMs ? setTimeout(terminate, opts.timeoutMs) : undefined;
    timer?.unref?.();
    // Already aborted is a real case — the job budget can expire between the
    // decision to run a command and the spawn — and a listener added to a
    // signal that has already fired never runs.
    if (opts.signal?.aborted) terminate();
    else opts.signal?.addEventListener("abort", terminate, { once: true });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", terminate);
      resolve({ exitCode, stdout, stderr, killed });
    };

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(127);
    });
    // `close`, not `exit`: exit fires before the pipes drain, which truncates
    // the tail of a suite's output exactly when it is most wanted.
    child.on("close", (code, sig) => finish(code ?? (sig ? 143 : 1)));
  });
}
