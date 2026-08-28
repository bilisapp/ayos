import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export const SIGNATURE_HEADER = "x-ayos-signature";
export const TIMESTAMP_HEADER = "x-ayos-timestamp";
/** Names the scheme, so a caller can tell an Ed25519 signature from the old HMAC. */
export const SIGNATURE_PREFIX = "ed25519=";

/**
 * Per-run signing. There is no shared secret any more: the caller mints one
 * Ed25519 keypair per job, keeps the public half on its own job record, and
 * injects the private half into this run. Ayos can prove it is this job and
 * nothing else — and a key recovered from a compromised run authenticates
 * exactly that job, which is already over.
 *
 * The signed string is `{timestamp}.{body}`, byte for byte the string Bilis's
 * `VerifyAyosSignature` already builds. Only the primitive changed, so the
 * caller's verification is one `sodium_crypto_sign_verify_detached` against the
 * same input it hashes today.
 */

/** The 16-byte PKCS#8 preamble for an Ed25519 private key holding a raw seed. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** The 12-byte SPKI preamble for a raw Ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Accepts either shape libsodium hands an operator: the 32-byte seed, or the
 * 64-byte secret key whose first half IS that seed. Refusing one of the two
 * only teaches people to paste the wrong thing.
 */
export function loadSigningKey(raw: string): KeyObject {
  const decoded = Buffer.from(raw.trim(), "base64");
  let seed: Buffer;
  if (decoded.length === 32) seed = decoded;
  else if (decoded.length === 64) seed = decoded.subarray(0, 32);
  else
    throw new Error(
      `signing_key decodes to ${decoded.length} bytes, expected 32 (seed) or 64 (secret key)`,
    );

  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/** The exact string both sides sign. Dots are separators, not escaping. */
export function signingInput(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** Signature headers for one outbound POST. */
export function signRequest(
  key: KeyObject,
  body: string,
  timestamp = nowSeconds(),
): Record<string, string> {
  const signature = cryptoSign(null, Buffer.from(signingInput(timestamp, body), "utf8"), key);
  return {
    [SIGNATURE_HEADER]: SIGNATURE_PREFIX + signature.toString("base64"),
    [TIMESTAMP_HEADER]: timestamp,
  };
}

/** The raw public half, base64 — what the caller stores on its job record. */
export function publicKeyBase64(key: KeyObject): string {
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(SPKI_ED25519_PREFIX.length)).toString("base64");
}

/** Verification, for tests and for anyone re-checking a signature locally. */
export function verifySignature(
  rawPublicKey: string,
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
): boolean {
  const signature = headers.signature?.trim();
  const timestamp = headers.timestamp?.trim();
  if (!signature?.startsWith(SIGNATURE_PREFIX) || !timestamp) return false;

  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(rawPublicKey.trim(), "base64")]),
    format: "der",
    type: "spki",
  });
  return cryptoVerify(
    null,
    Buffer.from(signingInput(timestamp, body), "utf8"),
    key,
    Buffer.from(signature.slice(SIGNATURE_PREFIX.length), "base64"),
  );
}
