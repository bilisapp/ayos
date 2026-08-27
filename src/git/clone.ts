import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Ignores the machine's own git configuration.
 *
 * `GIT_CONFIG_NOSYSTEM` alone is not enough — it leaves `~/.gitconfig` in play,
 * and a developer or CI box very often has settings there that change what a
 * credential-bearing clone does. The one that bites hardest is
 * `url."git@github.com:".insteadOf = https://github.com/`, which silently
 * rewrites our HTTPS clone to SSH: the askpass token path is then never used and
 * the clone either fails or succeeds via some unrelated key on the host. A
 * global `credential.helper`, `core.hooksPath` or `http.*` is the same class of
 * problem, and `core.excludesFile` can quietly drop an agent-added file from
 * `git add -A`, and therefore from the diff we ship.
 *
 * An explicit GIT_CONFIG_GLOBAL in the environment still wins, which is what
 * lets the tests point a fake origin at a local path.
 */
function isolatedGitConfig(): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
  };
}

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
 * Clones on the HOST, not in the VM. agentOS's `@agentos-software/git` package
 * does install a real `git` at /opt/agentos/bin/git, but it implements only a
 * slice of git: `clone`, `checkout`, `commit` and `rev-parse` work, while
 * `add`, `diff`, `status`, `ls-files` and `config` all exit 128 with
 * `GitSubcommandUnsupported` (probed against 0.3.3). Packaging needs exactly
 * the missing half, so the clone happens here and the tree is mounted in.
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
    ...isolatedGitConfig(),
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

/**
 * Puts `.git` back into a state the host can safely run git against.
 *
 * The `-c` overrides in `git()` beat repo config for every knob we can name,
 * but not for a filter driver: `.gitattributes` says `*.php filter=x` and
 * `.git/config` supplies `filter.x.clean = <command>`, which `git add -A` runs.
 * We cannot enumerate the driver names, so the repo config goes instead —
 * nothing in packaging needs a remote, and an undefined driver is a no-op, so a
 * minimal config leaves the diff identical and the attack surface empty.
 */
export async function sanitizeGitDir(hostPath: string): Promise<void> {
  const gitDir = join(hostPath, ".git");
  await writeFile(
    join(gitDir, "config"),
    ["[core]", "\trepositoryformatversion = 0", "\tfilemode = true", "\tbare = false", ""].join(
      "\n",
    ),
  );
  await rm(join(gitDir, "config.worktree"), { force: true }).catch(() => {});
  await rm(join(gitDir, "hooks"), { recursive: true, force: true }).catch(() => {});
}

/**
 * Overrides every repo-local knob that turns a read-only-looking git command
 * into command execution on the HOST.
 *
 * Once the VM has mounted the checkout, `.git` is agent-controlled: `.git/config`
 * and `.gitattributes` are just files it can write. `diff.external`, a
 * `diff.<driver>.command`/`textconv` pointed at by `.gitattributes`,
 * `core.hooksPath`, `core.fsmonitor`, `core.pager` and `core.sshCommand` all name
 * a program git will happily run for us during packaging. `-c` beats repo config,
 * so these win regardless of what the agent wrote — the treat-`.git`-as-untrusted
 * position, expressed as flags.
 */
const HARDENED_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.sshCommand=false",
  "-c", "core.askPass=",
  "-c", "core.editor=false",
  "-c", "core.attributesFile=/dev/null",
  "-c", "core.excludesFile=/dev/null",
  "-c", "credential.helper=",
  "-c", "diff.external=",
  "-c", "protocol.ext.allow=never",
  "-c", "uploadpack.packObjectsHook=",
];

/**
 * Runs a git command against a host checkout, ignoring machine config AND any
 * config the agent may have planted in the checkout. Never throws on nonzero exit.
 */
export async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await run("git", [...HARDENED_CONFIG, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...isolatedGitConfig() },
    });
    return { stdout, stderr, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? stderrOf(err), ok: false };
  }
}
