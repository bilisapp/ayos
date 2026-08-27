import { git } from "../git/clone.ts";
import { truncateText } from "../events/schema.ts";
import type { Sandbox } from "../sandbox.ts";
import { WORKDIR } from "../git/clone.ts";

export interface DiffResult {
  diff: string;
  filesTouched: string[];
  lineCount: number;
  truncated: boolean;
}

/**
 * Stage everything (so new files appear) and diff against the pinned base.
 *
 * Runs on the HOST against the checkout the VM has mounted: the agent's edits
 * land in that directory through the mount, and the host has real git. Ayos
 * never commits — the caller owns the write path.
 */
export async function packageDiff(
  hostPath: string,
  baseSha: string,
  maxDiffLines: number,
): Promise<DiffResult> {
  await git(hostPath, ["add", "-A"]);

  const names = await git(hostPath, ["diff", "--cached", "--name-only", baseSha]);
  const filesTouched = names.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const out = await git(hostPath, ["diff", "--cached", baseSha]);
  const diff = out.stdout;
  const lines = diff ? diff.split("\n") : [];

  if (lines.length > maxDiffLines) {
    return {
      diff: `${lines.slice(0, maxDiffLines).join("\n")}\n...[diff truncated at ${maxDiffLines} lines; ${lines.length} total]`,
      filesTouched,
      lineCount: lines.length,
      truncated: true,
    };
  }
  return { diff, filesTouched, lineCount: lines.length, truncated: false };
}

export interface TestRun {
  cmd: string;
  passed: boolean;
  output_tail: string;
  durationMs: number;
}

const TAIL_BYTES = 8192;

/**
 * Runs the caller's test command inside the VM, against the mounted checkout.
 * Never throws on a failing test — a red suite is a result, not an error.
 */
export async function runTests(
  sandbox: Sandbox,
  cmd: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TestRun> {
  const started = Date.now();
  const res = await sandbox.exec("sh", ["-lc", cmd], {
    cwd: WORKDIR,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();
  return {
    cmd,
    passed: res.exitCode === 0,
    output_tail: truncateText(combined.slice(-TAIL_BYTES), TAIL_BYTES),
    durationMs: Date.now() - started,
  };
}

/**
 * The binary a test command needs on PATH. agentOS's guest ships coreutils and
 * friends but no language runtimes, so this is what the preflight check looks
 * for before we let a job get as far as reporting a confusing test failure.
 */
export function requiredToolFor(testCmd: string): string | null {
  const first = testCmd.trim().split(/\s+/)[0] ?? "";
  const bin = first.split("/").at(-1) ?? "";
  // Shell builtins and coreutils are always present; only runtimes are at risk.
  const RUNTIMES = new Set([
    "php",
    "node",
    "npm",
    "pnpm",
    "yarn",
    "npx",
    "python",
    "python3",
    "pytest",
    "ruby",
    "bundle",
    "go",
    "cargo",
    "java",
    "mvn",
    "gradle",
    "dotnet",
    "composer",
  ]);
  return RUNTIMES.has(bin) ? bin : null;
}

/** Paths the caller forbade. The agent was told; this checks whether it listened. */
export function violatesDenylist(files: string[], denylist: string[]): string[] {
  if (!denylist.length) return [];
  const matchers = denylist.map(globToRegExp);
  return files.filter((f) => matchers.some((re) => re.test(f)));
}

/**
 * Minimal gitignore-style glob. Scanned character by character rather than
 * chained replaces, so a `*` produced by one substitution cannot be re-consumed
 * by the next.
 *
 *   `.github/**`  -> the directory and everything under it
 *   `.env*`       -> one path segment only
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          // `**/` - zero or more leading segments.
          i++;
          out += "(?:.*/)?";
        } else if (i === glob.length - 1 && out.endsWith("/")) {
          // Trailing `dir/**` - the directory itself or anything beneath it.
          out = out.slice(0, -1) + "(?:/.*)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += /[.+^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp(`^${out}$`);
}
