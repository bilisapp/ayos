import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox.ts";

export interface ExecCall {
  cmd: string;
  args: string[];
  opts: ExecOptions | undefined;
}

/** Return a partial result to override the default `exitCode: 0` empty result. */
export type ExecHandler = (call: ExecCall, index: number) => Partial<ExecResult> | void;

/**
 * In-memory Sandbox. Records every exec so tests can assert on argv, cwd and
 * options without booting a VM.
 *
 * This is much smaller than it used to be: the clone and the diff now run on
 * the host against a real checkout, so `runTests` is the only thing left that
 * genuinely goes through the VM.
 */
export class FakeSandbox implements Sandbox {
  readonly execCalls: ExecCall[] = [];
  readonly files = new Map<string, string>();
  disposeCount = 0;

  constructor(private handler: ExecHandler = () => undefined) {}

  async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    const call: ExecCall = { cmd, args, opts };
    const index = this.execCalls.length;
    this.execCalls.push(call);
    const override = this.handler(call, index) ?? {};
    return { exitCode: 0, stdout: "", stderr: "", ...override };
  }

  async writeFile(path: string, contents: string): Promise<void> {
    this.files.set(path, contents);
  }

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async dispose(): Promise<void> {
    this.disposeCount++;
  }
}
