import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Fixtures for the tests that now talk to real git. The clone moved to the
 * host, so there is nothing left to fake: these build throwaway repositories
 * under the OS temp dir and never touch the network.
 */

/** Run git and throw on failure. Test-side only — `src/git/clone.ts` has its own. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: process.env });
  return stdout.trim();
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Write `contents` as the global git config for this process; returns a restore fn. */
export async function installGitConfig(dir: string, contents: string): Promise<() => void> {
  const path = join(dir, "test-gitconfig");
  await writeFile(path, contents);
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = path;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  return () => {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prevSystem;
  };
}

/** `git init` at `path` (created if needed), with an identity and a `main` branch. */
export async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.email", "test@ayos.invalid");
  await git(path, "config", "user.name", "Ayos Test");
  await git(path, "config", "commit.gpgsign", "false");
  // Needed to serve `--filter=blob:none` and a by-sha fetch over file://.
  await git(path, "config", "uploadpack.allowFilter", "true");
  await git(path, "config", "uploadpack.allowAnySHA1InWant", "true");
}

export async function writeIn(repo: string, rel: string, contents: string): Promise<void> {
  const full = join(repo, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

/** Stage everything and commit; returns the new sha. */
export async function commitAll(repo: string, message: string): Promise<string> {
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/**
 * A repo with one commit containing `files`, ready to be mutated in the working
 * tree. Returns its path and the sha of that commit.
 */
export async function seedRepo(
  files: Record<string, string>,
  prefix = "ayos-test-repo-",
): Promise<{ path: string; sha: string; cleanup(): Promise<void> }> {
  const path = await makeTempDir(prefix);
  await initRepo(path);
  for (const [rel, contents] of Object.entries(files)) await writeIn(path, rel, contents);
  const sha = await commitAll(path, "seed");
  return { path, sha, cleanup: () => rm(path, { recursive: true, force: true }) };
}
