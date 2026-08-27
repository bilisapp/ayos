/**
 * The surface Ayos needs from a VM. agentOS is the real implementation; tests
 * use a fake. Keeping this narrow is what makes the lifecycle testable without
 * booting anything.
 */
export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  /** Run a command. Never throws on non-zero exit — inspect `exitCode`. */
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, contents: string, opts?: { mode?: number }): Promise<void>;
  readFile(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  /** Dispose the VM. Must be safe to call twice. */
  dispose(): Promise<void>;
}

export interface SandboxProvisionOptions {
  jobId: string;
  /** Hosts the VM may reach. Everything else is denied — the blast-radius control. */
  egressAllowlist: string[];
  /** Host directory holding the checkout, mounted read-write into the VM. */
  hostRepoPath: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SandboxProvider {
  provision(opts: SandboxProvisionOptions): Promise<Sandbox>;
}

/**
 * Hosts a job needs. The git host is deliberately absent: the clone happens on
 * the host before the VM boots, so the agent has no reason to reach it.
 */
export function egressAllowlistFor(opts: { llmHost: string; registries?: string[] }): string[] {
  return [...new Set([opts.llmHost, ...(opts.registries ?? [])])];
}

/** Registries a test command plausibly needs. Conservative: no match → nothing added. */
export function registriesForTestCmd(testCmd: string | null): string[] {
  if (!testCmd) return [];
  const hosts: string[] = [];
  if (/\b(composer|artisan|php|phpunit|pest)\b/.test(testCmd)) hosts.push("repo.packagist.org");
  if (/\b(npm|pnpm|yarn|node|vitest|jest)\b/.test(testCmd))
    hosts.push("registry.npmjs.org");
  if (/\b(pip|pytest|python)\b/.test(testCmd)) hosts.push("pypi.org", "files.pythonhosted.org");
  if (/\b(cargo|rustc)\b/.test(testCmd)) hosts.push("static.crates.io", "index.crates.io");
  if (/\bgo\b/.test(testCmd)) hosts.push("proxy.golang.org");
  return hosts;
}
