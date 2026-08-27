import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair, type KeyLike } from "jose";
import { STREAM_SCOPE, loadPublicKey, verifyStreamToken } from "../src/auth/streamJwt.ts";

const JOB = "6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44";
const OTHER_JOB = "11111111-2222-3333-4444-555555555555";

let publicKey: KeyLike;
let privateKey: KeyLike;
let otherPrivateKey: KeyLike;
let spki: string;

beforeAll(async () => {
  const kp = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  publicKey = kp.publicKey as KeyLike;
  privateKey = kp.privateKey as KeyLike;
  const other = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  otherPrivateKey = other.privateKey as KeyLike;
  spki = await exportSPKI(publicKey);
});

interface MintOpts {
  job?: string;
  scope?: string | undefined;
  sub?: string | undefined;
  expIn?: string | number;
  key?: KeyLike;
  alg?: string;
}

async function mint(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = { job: opts.job ?? JOB };
  if (opts.scope !== undefined) claims.scope = opts.scope;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "EdDSA" })
    .setIssuedAt()
    .setExpirationTime(opts.expIn ?? "10m");
  if (opts.sub !== undefined) jwt.setSubject(opts.sub);
  else jwt.setSubject("viewer-42");
  return jwt.sign(opts.key ?? privateKey);
}

describe("verifyStreamToken", () => {
  it("accepts a well-formed token for the right job", async () => {
    const res = await verifyStreamToken(publicKey, await mint({ scope: STREAM_SCOPE }), JOB);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.job).toBe(JOB);
      expect(res.claims.sub).toBe("viewer-42");
      expect(res.claims.scope).toBe(STREAM_SCOPE);
    }
  });

  it("rejects a token minted for a DIFFERENT job id", async () => {
    const token = await mint({ job: OTHER_JOB, scope: STREAM_SCOPE });
    const res = await verifyStreamToken(publicKey, token, JOB);
    expect(res).toEqual({ ok: false, reason: "token not valid for this job" });
  });

  it("rejects a token with a missing or wrong scope", async () => {
    const wrong = await verifyStreamToken(publicKey, await mint({ scope: "admin" }), JOB);
    expect(wrong).toEqual({ ok: false, reason: "wrong scope" });
    const none = await verifyStreamToken(publicKey, await mint({}), JOB);
    expect(none).toEqual({ ok: false, reason: "wrong scope" });
    const near = await verifyStreamToken(publicKey, await mint({ scope: "stream:write" }), JOB);
    expect(near.ok).toBe(false);
  });

  it("rejects a token with no sub (audit trail is mandatory)", async () => {
    const claims = { job: JOB, scope: STREAM_SCOPE };
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA" })
      .setExpirationTime("10m")
      .sign(privateKey);
    expect(await verifyStreamToken(publicKey, token, JOB)).toEqual({
      ok: false,
      reason: "missing sub",
    });
  });

  it("rejects an expired token (exp enforced at connect time)", async () => {
    const token = await mint({ scope: STREAM_SCOPE, expIn: Math.floor(Date.now() / 1000) - 60 });
    const res = await verifyStreamToken(publicKey, token, JOB);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/exp/i);
  });

  it("rejects a token signed by a different Ed25519 key", async () => {
    const token = await mint({ scope: STREAM_SCOPE, key: otherPrivateKey });
    const res = await verifyStreamToken(publicKey, token, JOB);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/signature/i);
  });

  it("rejects an HS256 token signed with the public key material (algorithm confusion)", async () => {
    const secret = new TextEncoder().encode(spki);
    const token = await new SignJWT({ job: JOB, scope: STREAM_SCOPE })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("attacker")
      .setExpirationTime("10m")
      .sign(secret);
    const res = await verifyStreamToken(publicKey, token, JOB);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/alg/i);
  });

  it('rejects an unsigned alg:"none" token', async () => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: "attacker",
      job: JOB,
      scope: STREAM_SCOPE,
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    const res = await verifyStreamToken(publicKey, token, JOB);
    expect(res.ok).toBe(false);
  });

  it("rejects a token whose payload was tampered with after signing", async () => {
    const token = await mint({ job: OTHER_JOB, scope: STREAM_SCOPE });
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        sub: "viewer-42",
        job: JOB,
        scope: STREAM_SCOPE,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    const res = await verifyStreamToken(publicKey, `${h}.${forged}.${s}`, JOB);
    expect(res.ok).toBe(false);
  });

  it("rejects garbage instead of throwing", async () => {
    for (const bad of ["", "not.a.token", "a.b", "....."]) {
      const res = await verifyStreamToken(publicKey, bad, JOB);
      expect(res.ok, bad).toBe(false);
    }
  });
});

describe("loadPublicKey", () => {
  it("loads a PEM SPKI key that then verifies a real token", async () => {
    const key = await loadPublicKey(spki);
    const res = await verifyStreamToken(key, await mint({ scope: STREAM_SCOPE }), JOB);
    expect(res.ok).toBe(true);
  });

  it("loads a PEM with escaped \\n (the shape env vars arrive in)", async () => {
    const key = await loadPublicKey(spki.trim().replace(/\n/g, "\\n"));
    const res = await verifyStreamToken(key, await mint({ scope: STREAM_SCOPE }), JOB);
    expect(res.ok).toBe(true);
  });

  it("loads bare base64 DER with no PEM armour", async () => {
    const bare = spki
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "");
    expect(bare).not.toContain("BEGIN");
    const key = await loadPublicKey(bare);
    const res = await verifyStreamToken(key, await mint({ scope: STREAM_SCOPE }), JOB);
    expect(res.ok).toBe(true);
  });

  it("loads bare base64 that arrived with stray whitespace/newlines", async () => {
    const bare = spki.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
    const messy = `  ${bare.slice(0, 20)}\n ${bare.slice(20)}  \n`;
    const key = await loadPublicKey(messy);
    expect((await verifyStreamToken(key, await mint({ scope: STREAM_SCOPE }), JOB)).ok).toBe(true);
  });

  it("rejects material that is not a public key", async () => {
    await expect(loadPublicKey("bm90LWEta2V5")).rejects.toThrow();
  });
});
