import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox.ts";

export interface ExecCall {
  cmd: string;
  args: string[];
  opts: ExecOptions | undefined;
}

/** Return a partial result to override the default `exitCode: 0` empty result. */
export type ExecHandler = (call: ExecCall, index: number) => Partial<ExecResult> | void;

export interface WrittenFile {
  path: string;
  contents: string;
  mode: number | undefined;
}

/**
 * In-memory Sandbox. Records everything so tests can assert on argv, env, and
 * the file lifecycle without booting a VM.
 */
export class FakeSandbox implements Sandbox {
  readonly execCalls: ExecCall[] = [];
  readonly writes: WrittenFile[] = [];
  readonly removed: string[] = [];
  readonly files = new Map<string, string>();
  disposeCount = 0;
  removeShouldThrow = false;

  constructor(private handler: ExecHandler = () => undefined) {}

  setHandler(handler: ExecHandler): void {
    this.handler = handler;
  }

  async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const call: ExecCall = { cmd, args, opts };
    const index = this.execCalls.length;
    this.execCalls.push(call);
    const override = this.handler(call, index) ?? {};
    return { exitCode: 0, stdout: "", stderr: "", ...override };
  }

  async writeFile(path: string, contents: string, opts?: { mode?: number }): Promise<void> {
    this.writes.push({ path, contents, mode: opts?.mode });
    this.files.set(path, contents);
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async remove(path: string): Promise<void> {
    if (this.removeShouldThrow) throw new Error(`EACCES: ${path}`);
    this.removed.push(path);
    this.files.delete(path);
  }

  async dispose(): Promise<void> {
    this.disposeCount++;
  }

  /** Every exec as `cmd arg arg …`, for leak assertions. */
  commandLines(): string[] {
    return this.execCalls.map((c) => [c.cmd, ...c.args].join(" "));
  }

  /** Everything the sandbox ever saw as argv (NOT env) — where a token must never appear. */
  argvText(): string {
    return JSON.stringify(this.execCalls.map((c) => [c.cmd, ...c.args]));
  }

  envs(): Record<string, string>[] {
    return this.execCalls.map((c) => c.opts?.env ?? {});
  }
}
