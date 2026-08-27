import type { Sandbox, SandboxProvider, SandboxProvisionOptions, ExecOptions, ExecResult } from "../sandbox.ts";
import { assertEgressEnforced, CANARY_HOST } from "./permissions.ts";

/**
 * The slice of the agentOS actor handle we use. Declared structurally rather
 * than imported: the generated handle type is deeply generic, and pinning it
 * would couple us to the actor definition's inference.
 */
export interface VmHandle {
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  readFile(path: string, encoding?: string): Promise<string>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<unknown>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  execArgv(
    command: string,
    args?: readonly string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  httpRequest(input: { url: string; method?: string; timeoutMs?: number }): Promise<unknown>;
  sessions: {
    open(input: Record<string, unknown>): Promise<unknown>;
    prompt(input: Record<string, unknown>): Promise<PromptResult>;
    cancelPrompt(input: { sessionId: string }): Promise<{ status: string }>;
    delete(input: { sessionId: string }): Promise<unknown>;
  };
  dispose?(): Promise<void>;
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
    const res = await this.vm.execArgv(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
    // agentOS types every field as optional; a missing exit code means the
    // process did not report one, which we treat as failure rather than success.
    return {
      exitCode: res.exitCode ?? 1,
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.conn.dispose();
    } catch {
      // Already closed; nothing to do.
    }
    await this.vm.dispose?.().catch(() => {});
  }
}

export interface AgentOsProviderOptions {
  client: AgentOsClient;
  /** Verify the egress allowlist actually bites before trusting the VM with credentials. */
  verifyEgress?: boolean;
}

export class AgentOsSandboxProvider implements SandboxProvider {
  constructor(private readonly opts: AgentOsProviderOptions) {}

  async provision(options: SandboxProvisionOptions): Promise<Sandbox> {
    const handle = this.opts.client.vm.getOrCreate([options.jobId], {
      createWithInput: { egressAllowlist: options.egressAllowlist },
    });
    const conn = handle.connect();
    await conn.ready;

    const sandbox = new AgentOsSandbox(handle, conn, options.jobId);

    if (this.opts.verifyEgress !== false) {
      try {
        await assertEgressEnforced(
          async (host) => {
            try {
              await handle.httpRequest({ url: `https://${host}/`, timeoutMs: 5000 });
              return { reachable: true };
            } catch {
              return { reachable: false };
            }
          },
          options.egressAllowlist,
        );
      } catch (err) {
        await sandbox.dispose();
        throw err;
      }
    }

    await handle.mkdir("/work", { recursive: true });
    return sandbox;
  }
}

export { CANARY_HOST };
