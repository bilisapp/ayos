import { describe, expect, it } from "vitest";
import { CloneError, WORKDIR, shallowClone } from "../src/git/clone.ts";
import { FakeSandbox, type ExecCall } from "./helpers/fakeSandbox.ts";

const TOKEN = "ghs_SuperSecretCloneToken0123456789";
const OPTS = {
  repo: "org/app",
  baseRef: "main",
  baseSha: "abc1234def5678",
  cloneToken: TOKEN,
};

const ASKPASS = "/tmp/ayos-askpass.sh";
const isClone = (c: ExecCall) => c.args[0] === "clone";
const isCheckout = (c: ExecCall) => c.args[0] === "checkout";
const isFetch = (c: ExecCall) => c.args[0] === "fetch";

describe("token handling", () => {
  it("never puts the token in argv or the remote URL", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);

    expect(sb.argvText()).not.toContain(TOKEN);
    for (const line of sb.commandLines()) expect(line).not.toContain(TOKEN);

    const clone = sb.execCalls.find(isClone)!;
    const url = clone.args.find((a) => a.startsWith("https://"))!;
    expect(url).toBe("https://github.com/org/app.git");
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("@");
    // no userinfo: nothing between the scheme and the host
    expect(url.replace(/^https:\/\//, "")).not.toContain(":");
  });

  it("delivers the token only through env, alongside an askpass script", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);

    const clone = sb.execCalls.find(isClone)!;
    expect(clone.opts?.env?.AYOS_GIT_TOKEN).toBe(TOKEN);
    expect(clone.opts?.env?.GIT_ASKPASS).toBe(ASKPASS);
    expect(clone.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(clone.opts?.env?.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("does not bake the token into the askpass script itself", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);

    const write = sb.writes.find((w) => w.path === ASKPASS)!;
    expect(write).toBeDefined();
    expect(write.contents).not.toContain(TOKEN);
    expect(write.contents).toContain("$AYOS_GIT_TOKEN");
    expect(write.contents.startsWith("#!/bin/sh")).toBe(true);
    expect(write.contents).toContain("x-access-token");
    expect(write.mode).toBe(0o700);
  });

  it("never runs a git config command that could persist the credential", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);
    expect(sb.execCalls.some((c) => c.args.includes("config"))).toBe(false);
    expect(sb.execCalls.some((c) => c.args.includes("credential.helper"))).toBe(false);
  });
});

describe("askpass lifecycle", () => {
  it("writes the askpass before the clone and removes it after success", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);
    expect(sb.writes.map((w) => w.path)).toEqual([ASKPASS]);
    expect(sb.removed).toEqual([ASKPASS]);
    expect(sb.files.has(ASKPASS)).toBe(false);
  });

  it("removes the askpass even when the clone fails", async () => {
    const sb = new FakeSandbox((c) => (isClone(c) ? { exitCode: 128, stderr: "auth failed" } : {}));
    await expect(shallowClone(sb, OPTS)).rejects.toThrow(CloneError);
    expect(sb.removed).toEqual([ASKPASS]);
  });

  it("removes the askpass when the sha is unreachable", async () => {
    const sb = new FakeSandbox((c) => {
      if (isCheckout(c)) return { exitCode: 1, stderr: "unknown revision" };
      if (isFetch(c)) return { exitCode: 1, stderr: "no such object" };
      return {};
    });
    await expect(shallowClone(sb, OPTS)).rejects.toThrow(/not reachable/);
    expect(sb.removed).toEqual([ASKPASS]);
  });

  it("swallows a failure to delete the askpass rather than masking the real result", async () => {
    const sb = new FakeSandbox();
    sb.removeShouldThrow = true;
    await expect(shallowClone(sb, OPTS)).resolves.toMatchObject({ dir: WORKDIR });
  });
});

describe("clone flags", () => {
  it("is shallow, blobless, single-branch and pinned to base_ref", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);

    const args = sb.execCalls.find(isClone)!.args;
    expect(args).toEqual([
      "clone",
      "--depth",
      "50",
      "--filter=blob:none",
      "--single-branch",
      "--branch",
      "main",
      "https://github.com/org/app.git",
      WORKDIR,
    ]);
  });

  it("honours a custom depth and host", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, { ...OPTS, depth: 5, host: "git.internal.test" });

    const args = sb.execCalls.find(isClone)!.args;
    expect(args[args.indexOf("--depth") + 1]).toBe("5");
    expect(args).toContain("https://git.internal.test/org/app.git");
  });

  it("passes the abort signal to every git invocation", async () => {
    const ac = new AbortController();
    const sb = new FakeSandbox();
    await shallowClone(sb, { ...OPTS, signal: ac.signal });
    for (const c of sb.execCalls) expect(c.opts?.signal).toBe(ac.signal);
  });
});

describe("checkout at base_sha", () => {
  it("checks out detached at the pinned sha inside the workdir", async () => {
    const sb = new FakeSandbox();
    const res = await shallowClone(sb, OPTS);

    const checkout = sb.execCalls.find(isCheckout)!;
    expect([checkout.cmd, ...checkout.args]).toEqual([
      "git",
      "checkout",
      "--detach",
      "abc1234def5678",
    ]);
    expect(checkout.opts?.cwd).toBe(WORKDIR);
    expect(res.dir).toBe(WORKDIR);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not fetch when the first checkout succeeds", async () => {
    const sb = new FakeSandbox();
    await shallowClone(sb, OPTS);
    expect(sb.execCalls.filter(isFetch)).toHaveLength(0);
    expect(sb.execCalls.filter(isCheckout)).toHaveLength(1);
  });

  it("fetches the sha then retries the checkout when the branch tip has moved", async () => {
    let checkouts = 0;
    const sb = new FakeSandbox((c) => {
      if (isCheckout(c)) {
        checkouts++;
        return checkouts === 1 ? { exitCode: 1, stderr: "reference is not a tree" } : { exitCode: 0 };
      }
      return {};
    });

    const res = await shallowClone(sb, OPTS);
    expect(res.dir).toBe(WORKDIR);

    expect(sb.execCalls.map((c) => c.args[0])).toEqual(["clone", "checkout", "fetch", "checkout"]);
    const fetch = sb.execCalls.find(isFetch)!;
    expect(fetch.args).toEqual(["fetch", "--depth", "50", "origin", "abc1234def5678"]);
    expect(fetch.opts?.cwd).toBe(WORKDIR);
    expect(sb.argvText()).not.toContain(TOKEN);
    expect(fetch.opts?.env?.AYOS_GIT_TOKEN).toBe(TOKEN);
  });

  it("fails with the retry's stderr when the checkout still fails after fetching", async () => {
    const sb = new FakeSandbox((c) =>
      isCheckout(c) ? { exitCode: 1, stderr: "still broken" } : {},
    );
    await expect(shallowClone(sb, OPTS)).rejects.toMatchObject({
      name: "CloneError",
      message: `checkout ${OPTS.baseSha} failed`,
      stderr: "still broken",
    });
    expect(sb.execCalls.filter(isCheckout)).toHaveLength(2);
  });
});

describe("errors", () => {
  it("surfaces the clone exit code and stderr, and does not proceed to checkout", async () => {
    const sb = new FakeSandbox((c) =>
      isClone(c) ? { exitCode: 128, stderr: "fatal: repository not found" } : {},
    );
    await expect(shallowClone(sb, OPTS)).rejects.toMatchObject({
      name: "CloneError",
      message: "git clone failed (128)",
      stderr: "fatal: repository not found",
    });
    expect(sb.execCalls.filter(isCheckout)).toHaveLength(0);
  });

  it("keeps the token out of the error it throws", async () => {
    const sb = new FakeSandbox((c) =>
      isClone(c) ? { exitCode: 128, stderr: "fatal: could not read Password" } : {},
    );
    const err = await shallowClone(sb, OPTS).catch((e: CloneError) => e);
    expect(String((err as CloneError).message) + (err as CloneError).stderr).not.toContain(TOKEN);
  });
});
