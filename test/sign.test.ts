import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  TIMESTAMP_HEADER,
  loadSigningKey,
  publicKeyBase64,
  signRequest,
  signingInput,
  verifySignature,
} from "../src/auth/sign.ts";

/** The 32-byte seed out of a fresh keypair — what a caller would mint per job. */
function freshSeed(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return Buffer.from(
    privateKey.export({ format: "der", type: "pkcs8" }).subarray(16),
  ).toString("base64");
}

/*
 * The golden vector below was produced by PHP's libsodium — the same primitive
 * Bilis verifies with — and is pinned for the same reason the HMAC vector was:
 * a silent divergence in what gets signed 401s every artifact this service
 * ever posts, and the two codebases cannot notice on their own.
 *
 *   $seed = str_repeat("\x01", 32);
 *   $kp   = sodium_crypto_sign_seed_keypair($seed);
 *   $sig  = sodium_crypto_sign_detached($ts . "." . $body,
 *                                       sodium_crypto_sign_secretkey($kp));
 */
const GOLDEN = {
  seed: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  publicKey: "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
  timestamp: "1735689600",
  body: '{"job_id":"6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44","status":"done"}',
  signature: "GaSzvRd9NJsM+H880IaKlp3HlSo1xOjmdmIlT765s450reNnpBOd/pIeo9mPn5MUtzFShI82pzC4sT5vuLaAAQ==",
};

describe("golden vector against PHP libsodium", () => {
  it("derives the same public key from the seed", () => {
    expect(publicKeyBase64(loadSigningKey(GOLDEN.seed))).toBe(GOLDEN.publicKey);
  });

  it("produces byte-identical signatures", () => {
    const headers = signRequest(loadSigningKey(GOLDEN.seed), GOLDEN.body, GOLDEN.timestamp);
    expect(headers[SIGNATURE_HEADER]).toBe(SIGNATURE_PREFIX + GOLDEN.signature);
    expect(headers[TIMESTAMP_HEADER]).toBe(GOLDEN.timestamp);
  });

  it("verifies PHP's signature", () => {
    expect(
      verifySignature(GOLDEN.publicKey, GOLDEN.body, {
        signature: SIGNATURE_PREFIX + GOLDEN.signature,
        timestamp: GOLDEN.timestamp,
      }),
    ).toBe(true);
  });

  it("signs `{timestamp}.{body}` — the string Bilis already builds", () => {
    expect(signingInput(GOLDEN.timestamp, GOLDEN.body)).toBe(
      `${GOLDEN.timestamp}.${GOLDEN.body}`,
    );
  });
});

describe("loadSigningKey", () => {
  it("accepts a 32-byte seed", () => {
    expect(() => loadSigningKey(freshSeed())).not.toThrow();
  });

  it("accepts the 64-byte secret key libsodium hands out", () => {
    const seed = Buffer.from(GOLDEN.seed, "base64");
    const publicKey = Buffer.from(GOLDEN.publicKey, "base64");
    const secretKey = Buffer.concat([seed, publicKey]).toString("base64");

    expect(publicKeyBase64(loadSigningKey(secretKey))).toBe(GOLDEN.publicKey);
  });

  it("tolerates surrounding whitespace, which a pasted key always has", () => {
    expect(publicKeyBase64(loadSigningKey(`  ${GOLDEN.seed}\n`))).toBe(GOLDEN.publicKey);
  });

  it("names the length it got when the key is the wrong size", () => {
    expect(() => loadSigningKey(Buffer.alloc(31).toString("base64"))).toThrow(/31 bytes/);
  });
});

describe("verifySignature", () => {
  const key = loadSigningKey(GOLDEN.seed);
  const body = '{"hello":"world"}';
  const headers = signRequest(key, body, "1735689600");

  it("accepts what signRequest produced", () => {
    expect(
      verifySignature(GOLDEN.publicKey, body, {
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
      }),
    ).toBe(true);
  });

  it("rejects a changed body", () => {
    expect(
      verifySignature(GOLDEN.publicKey, `${body} `, {
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
      }),
    ).toBe(false);
  });

  /*
   * The timestamp is INSIDE the signature. That is what makes the caller's
   * freshness window meaningful: a captured body cannot be replayed later
   * under a fresh timestamp, because the fresh timestamp invalidates the
   * signature. The old body-only HMAC could be, and that was the bug.
   */
  it("rejects a swapped timestamp", () => {
    expect(
      verifySignature(GOLDEN.publicKey, body, {
        signature: headers[SIGNATURE_HEADER],
        timestamp: "1735689601",
      }),
    ).toBe(false);
  });

  it("rejects a signature from a different run's key", () => {
    const other = loadSigningKey(freshSeed());
    const otherHeaders = signRequest(other, body, "1735689600");
    expect(
      verifySignature(GOLDEN.publicKey, body, {
        signature: otherHeaders[SIGNATURE_HEADER],
        timestamp: otherHeaders[TIMESTAMP_HEADER],
      }),
    ).toBe(false);
  });

  it.each([
    ["missing signature", { signature: undefined, timestamp: "1735689600" }],
    ["missing timestamp", { signature: `${SIGNATURE_PREFIX}AAAA`, timestamp: undefined }],
    ["unprefixed signature", { signature: "AAAA", timestamp: "1735689600" }],
    ["hmac signature", { signature: "sha256=deadbeef", timestamp: "1735689600" }],
    ["garbage signature", { signature: `${SIGNATURE_PREFIX}not-base64!!`, timestamp: "1735689600" }],
  ])("rejects %s", (_name, headers) => {
    expect(verifySignature(GOLDEN.publicKey, body, headers)).toBe(false);
  });
});
