import { describe, expect, it } from "vitest";
import { AgentOsSandbox, DEFAULT_EXEC_TIMEOUT_MS } from "../src/sandbox/agentos.ts";
import type { CodeExecutionResult, VmConn, VmHandle } from "../src/sandbox/agentos.ts";

type ExecOpts = { cwd?: string; timeoutMs?: number };

/** Records what reached the actor, and can hang forever on demand. */
function fakeVm(behaviour: (opts: ExecOpts) => Promise<CodeExecutionResult>) {
  const calls: ExecOpts[] = [];
  const vm = {
    process: {
      execFile: async (_cmd: string, _args?: readonly string[], opts: ExecOpts = {}) => {
        calls.push(opts);
        return behaviour(opts);
      },
    },
    shutdown: async () => undefined,
  } as unknown as VmHandle;
  const conn = { dispose() {} } as unknown as VmConn;
  return { sandbox: new AgentOsSandbox(vm, conn, "job-1"), calls };
}

describe("AgentOsSandbox.exec", () => {
  it("caps a command that supplies no timeout of its own", async () => {
    const { sandbox, calls } = fakeVm(async () => ({ exitCode: 0, outcome: "succeeded" }));
    await sandbox.exec("sh", ["-lc", "true"]);
    expect(calls[0]!.timeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  it("passes an explicit timeout through unchanged", async () => {
    const { sandbox, calls } = fakeVm(async () => ({ exitCode: 0, outcome: "succeeded" }));
    await sandbox.exec("sh", ["-lc", "true"], { timeoutMs: 1234 });
    expect(calls[0]!.timeoutMs).toBe(1234);
  });

  it("stops waiting when the job is aborted, even if the command never returns", async () => {
    const { sandbox } = fakeVm(() => new Promise<CodeExecutionResult>(() => {}));
    const controller = new AbortController();
    const pending = sandbox.exec("sh", ["-lc", "sleep 999"], { signal: controller.signal });
    controller.abort("cancelled");
    expect(await pending).toEqual({ exitCode: 124, stdout: "", stderr: "aborted" });
  });

  it("reports a guest-side timeout as 124", async () => {
    const { sandbox } = fakeVm(async () => ({ outcome: "timed_out" }));
    expect((await sandbox.exec("sh", ["-lc", "sleep 999"])).exitCode).toBe(124);
  });
});
