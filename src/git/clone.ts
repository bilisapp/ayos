import type { Sandbox } from "../sandbox.ts";

export const WORKDIR = "/work/repo";
const ASKPASS_PATH = "/tmp/ayos-askpass.sh";

export interface CloneOptions {
  repo: string;
  baseRef: string;
  baseSha: string;
  cloneToken: string;
  host?: string;
  depth?: number;
  signal?: AbortSignal;
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

/**
 * Shallow clone at a pinned sha. The token is handed to git through a one-shot
 * GIT_ASKPASS script and deleted immediately after — it never reaches
 * .git/config, the remote URL, or shell history.
 */
export async function shallowClone(
  sandbox: Sandbox,
  opts: CloneOptions,
): Promise<{ dir: string; durationMs: number }> {
  const host = opts.host ?? "github.com";
  const depth = opts.depth ?? 50;
  const started = Date.now();

  // git calls this twice: once for username, once for password.
  await sandbox.writeFile(
    ASKPASS_PATH,
    ["#!/bin/sh", 'case "$1" in', "*Username*) echo x-access-token ;;", '*) printf "%s" "$AYOS_GIT_TOKEN" ;;', "esac", ""].join("\n"),
    { mode: 0o700 },
  );

  const env = {
    GIT_ASKPASS: ASKPASS_PATH,
    AYOS_GIT_TOKEN: opts.cloneToken,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  try {
    const clone = await sandbox.exec(
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
        WORKDIR,
      ],
      { env, signal: opts.signal },
    );
    if (clone.exitCode !== 0) throw new CloneError(`git clone failed (${clone.exitCode})`, clone.stderr);

    // The branch tip may have moved since the caller read base_sha; fetch it explicitly.
    const checkout = await sandbox.exec("git", ["checkout", "--detach", opts.baseSha], {
      cwd: WORKDIR,
      env,
      signal: opts.signal,
    });
    if (checkout.exitCode !== 0) {
      const fetch = await sandbox.exec("git", ["fetch", "--depth", String(depth), "origin", opts.baseSha], {
        cwd: WORKDIR,
        env,
        signal: opts.signal,
      });
      if (fetch.exitCode !== 0)
        throw new CloneError(`base_sha ${opts.baseSha} not reachable`, fetch.stderr || checkout.stderr);
      const retry = await sandbox.exec("git", ["checkout", "--detach", opts.baseSha], {
        cwd: WORKDIR,
        env,
        signal: opts.signal,
      });
      if (retry.exitCode !== 0) throw new CloneError(`checkout ${opts.baseSha} failed`, retry.stderr);
    }

    return { dir: WORKDIR, durationMs: Date.now() - started };
  } finally {
    // Best effort: the VM is disposable, but don't leave a token on disk for the agent to find.
    await sandbox.remove(ASKPASS_PATH).catch(() => {});
  }
}
