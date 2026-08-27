import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The clone runs real git on the host now, so these are integration tests.
 * Everything is served from a `file://` origin under the OS temp dir — no
 * network, no credentials that mean anything anywhere.
 *
 * The token can no longer be observed through a fake sandbox, so we watch argv
 * directly: `execFile` is wrapped (not replaced) so the real git still runs
 * while every argv vector is recorded.
 */
const argvLog = vi.hoisted(() => ({
  calls: [] as string[][],
  opts: [] as ({ signal?: AbortSignal; env?: NodeJS.ProcessEnv } | undefined)[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const real = actual.execFile as unknown as Record<symbol, Function> & Function;
  const wrapped = ((...args: unknown[]) => real(...args)) as unknown as Record<symbol, Function> &
    Function;
  wrapped[custom] = (file: string, args: string[] | undefined, opts?: unknown) => {
    argvLog.calls.push([file, ...(args ?? [])]);
    argvLog.opts.push(opts as { signal?: AbortSignal; env?: NodeJS.ProcessEnv } | undefined);
    return real[custom]!(file, args, opts);
  };
  return { ...actual, execFile: wrapped, default: { ...actual, execFile: wrapped } };
});

const { CloneError, WORKDIR, shallowClone } = await import("../src/git/clone.ts");
const { commitAll, git, initRepo, installGitConfig, makeTempDir, writeIn } = await import(
  "./helpers/tempRepo.ts"
);

const TOKEN = "ghs_SuperSecretCloneToken0123456789";
const TIMEOUT = 30_000;
const MISSING_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

let root: string;
let originsRoot: string;
let originPath: string;
let firstSha: string;
let headSha: string;
let sideSha: string;
let restoreGitConfig: () => void;

/** Temp dirs `shallowClone` created, so a failure path can be proven to leave none. */
async function ayosTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  // `mkdtemp(tmpdir() + "/ayos-")` appends exactly six random characters; the
  // fixture directories in this suite use longer, named prefixes.
  return entries.filter((e) => /^ayos-[A-Za-z0-9]{6}$/.test(e)).sort();
}

function opts(overrides: Partial<Parameters<typeof shallowClone>[0]> = {}) {
  return { repo: "org/app", baseRef: "main", baseSha: headSha, cloneToken: TOKEN, ...overrides };
}

/** Await a clone that must fail, and hand back the typed error. */
async function cloneFailure(
  promise: Promise<unknown>,
): Promise<InstanceType<typeof CloneError>> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CloneError);
  return err as InstanceType<typeof CloneError>;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  root = await makeTempDir("ayos-origin-fixture-");
  originsRoot = join(root, "origins");
  originPath = join(originsRoot, "org", "app.git");

  // `shallowClone` hard-codes an https URL, so the only way to point it at a
  // local origin is a config-level rewrite. This also neutralises whatever the
  // developer's real ~/.gitconfig says.
  restoreGitConfig = await installGitConfig(
    root,
    `[url "file://${originsRoot}/"]\n\tinsteadOf = https://github.com/\n`,
  );

  await initRepo(originPath);
  await writeIn(originPath, "README.md", "hello\n");
  await writeIn(originPath, "app/Foo.php", "<?php\n// one\n");
  firstSha = await commitAll(originPath, "one");
  await writeIn(originPath, "app/Bar.php", "<?php\n// two\n");
  headSha = await commitAll(originPath, "two");

  // A commit that is NOT on `main`, so cloning `--single-branch --branch main`
  // cannot see it: this is what drives the fetch-by-sha fallback.
  await git(originPath, "checkout", "-q", "-b", "side");
  await writeIn(originPath, "app/Side.php", "<?php\n// side\n");
  sideSha = await commitAll(originPath, "side");
  await git(originPath, "checkout", "-q", "main");
}, TIMEOUT);

afterAll(async () => {
  restoreGitConfig?.();
  await rm(root, { recursive: true, force: true });
});

describe("checkout at base_sha", () => {
  it(
    "checks out exactly base_sha, detached, and reports where it landed",
    async () => {
      // Deliberately the *older* commit: proves we pin, rather than take the tip.
      const co = await shallowClone(opts({ baseSha: firstSha }));
      try {
        expect(await git(co.hostPath, "rev-parse", "HEAD")).toBe(firstSha);
        // detached HEAD -> no current branch
        expect(await git(co.hostPath, "branch", "--show-current")).toBe("");
        await expect(git(co.hostPath, "symbolic-ref", "HEAD")).rejects.toThrow();

        expect(await exists(join(co.hostPath, "README.md"))).toBe(true);
        expect(await exists(join(co.hostPath, "app", "Bar.php"))).toBe(false);
        expect(co.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "checks out the branch tip when base_sha is the tip",
    async () => {
      const co = await shallowClone(opts());
      try {
        expect(await git(co.hostPath, "rev-parse", "HEAD")).toBe(headSha);
        expect(await git(co.hostPath, "branch", "--show-current")).toBe("");
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "recovers a base_sha that is not on the cloned branch",
    async () => {
      argvLog.calls.length = 0;
      // `--single-branch --branch main` does not fetch this commit up front;
      // it is reached either by the promisor fetch the partial clone issues
      // during checkout, or by the explicit `fetch origin <sha>` fallback.
      const co = await shallowClone(opts({ baseSha: sideSha }));
      try {
        expect(await git(co.hostPath, "rev-parse", "HEAD")).toBe(sideSha);
        expect(await git(co.hostPath, "branch", "--show-current")).toBe("");
        for (const argv of argvLog.calls) expect(argv.join(" ")).not.toContain(TOKEN);
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "honours a custom depth",
    async () => {
      const co = await shallowClone(opts({ depth: 1 }));
      try {
        expect(await git(co.hostPath, "rev-parse", "HEAD")).toBe(headSha);
        expect(await git(co.hostPath, "rev-list", "--count", "HEAD")).toBe("1");
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );
});

describe("temp directory lifecycle", () => {
  it(
    "removes the whole temp directory on cleanup, and the askpass before returning",
    async () => {
      const co = await shallowClone(opts());
      const dir = dirname(co.hostPath);

      // The credential script is gone even though the clone succeeded.
      expect(await exists(join(dir, "askpass.sh"))).toBe(false);
      expect(await readdir(dir)).toEqual(["repo"]);

      await co.cleanup();
      expect(await exists(dir)).toBe(false);
      expect(await exists(co.hostPath)).toBe(false);

      // Safe to call twice — the job runner does exactly that on some paths.
      await expect(co.cleanup()).resolves.toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "leaves no temp directory behind when the clone fails",
    async () => {
      const before = await ayosTempDirs();
      await expect(shallowClone(opts({ repo: "org/does-not-exist" }))).rejects.toThrow(CloneError);
      expect(await ayosTempDirs()).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "leaves no temp directory behind when base_sha is unreachable",
    async () => {
      const before = await ayosTempDirs();
      await expect(shallowClone(opts({ baseSha: MISSING_SHA }))).rejects.toThrow(CloneError);
      expect(await ayosTempDirs()).toEqual(before);
    },
    TIMEOUT,
  );
});

describe("errors", () => {
  it(
    "rejects with CloneError and real stderr when the repo does not exist",
    async () => {
      const err = await cloneFailure(shallowClone(opts({ repo: "org/does-not-exist" })));

      expect(err.name).toBe("CloneError");
      expect(err.message).toBe("git clone failed");
      expect(err.stderr.length).toBeGreaterThan(0);
      expect(err.stderr).toMatch(/does-not-exist/);
      expect(err.stderr).not.toContain(TOKEN);
    },
    TIMEOUT,
  );

  it(
    "rejects mentioning the sha when base_sha is not reachable",
    async () => {
      const err = await cloneFailure(shallowClone(opts({ baseSha: MISSING_SHA })));

      expect(err.message).toContain(MISSING_SHA);
      expect(err.message).toMatch(/not reachable/);
      expect(err.stderr.length).toBeGreaterThan(0);
      expect(`${err.message}${err.stderr}`).not.toContain(TOKEN);
    },
    TIMEOUT,
  );
});

/* --------------------------------------------------------- credential safety */

describe("token handling", () => {
  it(
    "leaves the token nowhere in the checkout, and no askpass behind",
    async () => {
      argvLog.calls.length = 0;
      const co = await shallowClone(opts());
      try {
        const dir = dirname(co.hostPath);

        // .git/config — the classic leak, from a rewritten remote or a helper.
        const config = await readFile(join(co.hostPath, ".git", "config"), "utf8");
        expect(config).not.toContain(TOKEN);
        expect(config).not.toContain("x-access-token");
        expect(config).not.toMatch(/credential\.?helper/i);

        // The stored remote URL carries no userinfo at all.
        const stored = await git(co.hostPath, "config", "--get", "remote.origin.url");
        expect(stored).toBe("https://github.com/org/app.git");
        const remote = await git(co.hostPath, "remote", "get-url", "origin");
        expect(remote).not.toContain(TOKEN);
        expect(remote).not.toContain("x-access-token");

        // FETCH_HEAD records the URL it fetched from; absent after a plain clone.
        const fetchHead = await readFile(join(co.hostPath, ".git", "FETCH_HEAD"), "utf8").catch(
          () => "",
        );
        expect(fetchHead).not.toContain(TOKEN);

        // Belt and braces: nothing anywhere under the checkout.
        expect(await grepCount(co.hostPath, TOKEN)).toBe(0);

        // The one-shot askpass script is gone on the success path.
        expect(await exists(join(dir, "askpass.sh"))).toBe(false);
        expect(await readdir(dir)).toEqual(["repo"]);
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "never puts the token on any git command line",
    async () => {
      argvLog.calls.length = 0;
      const co = await shallowClone(opts());
      try {
        expect(argvLog.calls.length).toBeGreaterThan(0);
        for (const argv of argvLog.calls) {
          expect(argv.join(" ")).not.toContain(TOKEN);
          for (const arg of argv) expect(arg).not.toContain("x-access-token");
        }

        const cloneArgv = argvLog.calls.find((a) => a[1] === "clone");
        expect(cloneArgv).toBeDefined();
        const url = cloneArgv!.find((a) => a.startsWith("https://"))!;
        expect(url).toBe("https://github.com/org/app.git");
        // no userinfo: nothing between the scheme and the host
        expect(url.replace(/^https:\/\//, "")).not.toContain("@");
        expect(url.replace(/^https:\/\//, "")).not.toContain(":");
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "keeps the token off argv when every attempt fails",
    async () => {
      argvLog.calls.length = 0;
      await expect(shallowClone(opts({ baseSha: MISSING_SHA }))).rejects.toThrow(CloneError);

      // The retry checkout never runs: the fetch for the missing sha fails first.
      expect(argvLog.calls.map((a) => a[1])).toEqual(["clone", "checkout", "fetch"]);
      for (const argv of argvLog.calls) expect(argv.join(" ")).not.toContain(TOKEN);
    },
    TIMEOUT,
  );
});

describe("cancellation", () => {
  it(
    "passes the abort signal to every git invocation",
    async () => {
      argvLog.calls.length = 0;
      argvLog.opts.length = 0;
      const ac = new AbortController();

      const co = await shallowClone({ ...opts(), signal: ac.signal });
      try {
        expect(argvLog.opts.length).toBeGreaterThan(0);
        for (const o of argvLog.opts) expect(o?.signal).toBe(ac.signal);
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );

  it(
    "fails as a CloneError when the signal is already aborted",
    async () => {
      const err = await cloneFailure(
        shallowClone({ ...opts(), signal: AbortSignal.abort() }),
      );
      expect(err.message).toBe("git clone failed");
    },
    TIMEOUT,
  );
});

describe("token handling — environment", () => {
  it(
    "delivers the token through env only, alongside a one-shot askpass",
    async () => {
      argvLog.calls.length = 0;
      argvLog.opts.length = 0;
      const co = await shallowClone(opts());
      try {
        for (const o of argvLog.opts) {
          expect(o?.env?.AYOS_GIT_TOKEN).toBe(TOKEN);
          expect(o?.env?.GIT_TERMINAL_PROMPT).toBe("0");
          expect(o?.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
          expect(o?.env?.GIT_ASKPASS).toBe(join(dirname(co.hostPath), "askpass.sh"));
        }
      } finally {
        await co.cleanup();
      }
    },
    TIMEOUT,
  );
});

describe("mount point", () => {
  it("exposes the in-VM mount path the checkout is bound to", () => {
    expect(WORKDIR).toBe("/work/repo");
  });
});

/** Recursive content grep, including .git. Returns the number of matching files. */
async function grepCount(dir: string, needle: string): Promise<number> {
  let hits = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) hits += await grepCount(full, needle);
    else if (entry.isFile()) {
      const buf = await readFile(full).catch(() => Buffer.alloc(0));
      if (buf.includes(needle)) hits++;
    }
  }
  return hits;
}
