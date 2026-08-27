import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the host clone is mounted inside the VM. */
export const WORKDIR = "/work/repo";

export interface CloneOptions {
  repo: string;
  baseRef: string;
  baseSha: string;
  cloneToken: string;
  host?: string;
  depth?: number;
  signal?: AbortSignal;
}

export interface Checkout {
  /** Absolute host path of the clone — this is what gets mounted into the VM. */
  hostPath: string;
  durationMs: number;
  cleanup(): Promise<void>;
}

export class CloneError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CloneError";
  }
}

function stderrOf(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err)
    return String((err as { stderr: unknown }).stderr ?? "");
  return err instanceof Error ? err.message : String(err);
}

/**
 * Clones on the HOST, not in the VM: agentOS ships no working git today (the
 * git package registers but every invocation fails), so the clone happens here
 * and the tree is mounted into the VM.
 *
 * This is also the better security position. The clone token never enters the
 * VM at all, so the agent cannot reach it even if the prompt fence fails —
 * previously it was one `cat` away from a credential.
 *
 * The token still never reaches argv or .git/config: it goes through a one-shot
 * GIT_ASKPASS script that is deleted immediately after the clone.
 */
export async function shallowClone(opts: CloneOptions): Promise<Checkout> {
  const host = opts.host ?? "github.com";
  const depth = opts.depth ?? 50;
  const started = Date.now();

  const dir = await mkdtemp(join(tmpdir(), "ayos-"));
  const repoPath = join(dir, "repo");
  const askpassPath = join(dir, "askpass.sh");

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  // git calls this twice: once for username, once for password.
  await writeFile(
    askpassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      "*Username*) echo x-access-token ;;",
      '*) printf "%s" "$AYOS_GIT_TOKEN" ;;',
      "esac",
      "",
    ].join("\n"),
  );
  await chmod(askpassPath, 0o700);

  const env = {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    AYOS_GIT_TOKEN: opts.cloneToken,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const gitOpts = { env, signal: opts.signal, maxBuffer: 16 * 1024 * 1024 };

  try {
    try {
      await run(
        "git",
        [
          "clone",
          "--depth",
          String(depth),
          "--filter=blob:none",
          "--single-branch",
          "--branch",
          opts.baseRef,
          `https://${host}/${opts.repo}.git`,
          repoPath,
        ],
        gitOpts,
      );
    } catch (err) {
      throw new CloneError("git clone failed", stderrOf(err));
    }

    // The branch tip may have moved since the caller read base_sha, so fall
    // back to fetching that exact commit.
    try {
      await run("git", ["checkout", "--detach", opts.baseSha], { ...gitOpts, cwd: repoPath });
    } catch {
      try {
        await run("git", ["fetch", "--depth", String(depth), "origin", opts.baseSha], {
          ...gitOpts,
          cwd: repoPath,
        });
        await run("git", ["checkout", "--detach", opts.baseSha], { ...gitOpts, cwd: repoPath });
      } catch (err) {
        throw new CloneError(`base_sha ${opts.baseSha} not reachable`, stderrOf(err));
      }
    }

    return { hostPath: repoPath, durationMs: Date.now() - started, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  } finally {
    // Never leave a credential on disk, even briefly, even though the VM can't
    // see this directory.
    await rm(askpassPath, { force: true }).catch(() => {});
  }
}

/** Runs a git command against a host checkout. Never throws on nonzero exit. */
export async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await run("git", args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    return { stdout, stderr, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? stderrOf(err), ok: false };
  }
}
