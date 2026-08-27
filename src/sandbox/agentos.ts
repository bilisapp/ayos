import type {
  Sandbox,
  SandboxProvider,
  SandboxProvisionOptions,
  ExecOptions,
  ExecResult,
} from "../sandbox.ts";
import { assertEgressEnforced, CANARY_HOST } from "./permissions.ts";

/**
 * The slice of the agentOS actor handle we use. Declared structurally rather
 * than imported: the generated handle type is deeply generic, and pinning it
 * would couple us to the actor definition's inference.
 */
export interface CodeExecutionResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  outcome?: "succeeded" | "failed" | "timed_out";
  error?: { code?: string; message?: string };
}

export interface VmHandle {
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string, encoding?: string): Promise<string>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<unknown>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  process: {
    execFile(
      command: string,
      args?: readonly string[],
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
        output?: { capture?: "none" | "stderr" | "all" };
      },
    ): Promise<CodeExecutionResult>;
  };
  javascript: {
    execute(source: string, options?: { timeoutMs?: number }): Promise<CodeExecutionResult>;
  };
  sessions: {
    open(input: Record<string, unknown>): Promise<unknown>;
    prompt(input: Record<string, unknown>): Promise<PromptResult>;
    cancelPrompt(input: { sessionId: string }): Promise<{ status: string }>;
    delete(input: { sessionId: string }): Promise<unknown>;
  };
  /** Our own action — agentOS ships no destroy, see src/vm/actor.ts. */
  shutdown(): Promise<unknown>;
}

export interface PromptResult {
  sessionId: string;
  message: { id: string; role: string; content: Array<{ type: string; text?: string }> } | null;
  stopReason: string;
}

export interface VmConn {
  on(event: string, cb: (payload: unknown) => void): () => void;
  ready: Promise<unknown>;
  dispose(): void;
}

export interface AgentOsClient {
  vm: {
    getOrCreate(
      key: string | string[],
      opts?: { createWithInput?: unknown },
    ): VmHandle & { connect(): VmConn };
  };
}

/** A Sandbox backed by one agentOS VM actor, plus the live event connection. */
export class AgentOsSandbox implements Sandbox {
  private disposed = false;

  constructor(
    readonly vm: VmHandle,
    readonly conn: VmConn,
    readonly jobId: string,
  ) {}

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    // `output.capture` defaults to "none", which returns a result with no
    // stdout/stderr fields at all. Everything we run here is run for its output.
    const res = await this.vm.process.execFile(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      output: { capture: "all" },
    });

    // A nonzero exit does not throw, and a timeout comes back as an outcome
    // rather than an exception. Missing exitCode means the process reported
    // none, which we treat as failure rather than success.
    return {
      exitCode: res.outcome === "timed_out" ? 124 : (res.exitCode ?? 1),
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  }

  async writeFile(path: string, contents: string, opts: { mode?: number } = {}): Promise<void> {
    await this.vm.writeFile(path, contents);
    // agentOS's writeFile takes no mode, so an executable file needs a chmod.
    if (opts.mode !== undefined) {
      await this.exec("chmod", [opts.mode.toString(8).padStart(3, "0"), path]);
    }
  }

  async readFile(path: string): Promise<string> {
    return this.vm.readFile(path);
  }

  async remove(path: string): Promise<void> {
    await this.vm.remove(path, { force: true });
  }

  /**
   * Reclaims the VM. Idle sleep is NOT enough: a slept actor keeps both its
   * state and its entire root filesystem, so the repo and anything the agent
   * wrote would outlive the job. Destroy resets both, and the job id is safely
   * reusable immediately afterwards.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.conn.dispose();
    } catch {
      // Already closed; nothing to do.
    }
    await this.vm.shutdown().catch(() => {});
  }
}

export interface AgentOsProviderOptions {
  client: AgentOsClient;
  /** Verify the egress allowlist actually bites before trusting the VM with credentials. */
  verifyEgress?: boolean;
}

/**
 * Probes egress from INSIDE the guest. It has to be guest-side: the actor's
 * `httpRequest` action calls a service listening inside the VM, so it would
 * prove nothing about outbound policy.
 */
const PROBE_SOURCE = (host: string) => `
  try {
    const res = await fetch("https://${host}/", { method: "HEAD" });
    console.log(JSON.stringify({ reachable: true, status: res.status }));
  } catch (err) {
    console.log(JSON.stringify({ reachable: false, message: String(err && err.message) }));
  }
`;

export class AgentOsSandboxProvider implements SandboxProvider {
  constructor(private readonly opts: AgentOsProviderOptions) {}

  async provision(options: SandboxProvisionOptions): Promise<Sandbox> {
    const handle = this.opts.client.vm.getOrCreate([options.jobId], {
      createWithInput: {
        egressAllowlist: options.egressAllowlist,
        hostRepoPath: options.hostRepoPath,
      },
    });
    const conn = handle.connect();
    await conn.ready;

    const sandbox = new AgentOsSandbox(handle, conn, options.jobId);

    if (this.opts.verifyEgress !== false) {
      try {
        await assertEgressEnforced(async (host) => {
          const res = await handle.javascript.execute(PROBE_SOURCE(host), { timeoutMs: 10_000 });
          // If the probe itself failed to run we cannot claim egress is
          // enforced — treat an unreadable result as reachable and fail loudly.
          const line = (res.stdout ?? "").trim().split("\n").at(-1) ?? "";
          try {
            return { reachable: Boolean((JSON.parse(line) as { reachable: boolean }).reachable) };
          } catch {
            return { reachable: true };
          }
        }, options.egressAllowlist);
      } catch (err) {
        await sandbox.dispose();
        throw err;
      }
    }

    return sandbox;
  }
}

export { CANARY_HOST };
