import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-ayos-signature";
export const TIMESTAMP_HEADER = "x-ayos-timestamp";
export const SIGNATURE_PREFIX = "sha256=";
/** ±5 min replay window, per spec. */
export const TOLERANCE_SECONDS = 300;

/**
 * The signature covers the RAW BODY only, and the timestamp travels beside it
 * as a separate header — matching the spec and the caller's implementation
 * (Bilis's `VerifyAyosSignature`) byte for byte.
 *
 * Timestamps are Unix seconds as a decimal string, again matching the caller.
 */
function digest(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

export function sign(secret: string, body: string, timestamp = nowSeconds()) {
  return {
    [SIGNATURE_HEADER]: SIGNATURE_PREFIX + digest(secret, body).toString("hex"),
    [TIMESTAMP_HEADER]: timestamp,
  } as Record<string, string>;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(
  secret: string,
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
  nowMs = Date.now(),
): VerifyResult {
  const signature = headers.signature?.trim();
  const timestamp = headers.timestamp?.trim();

  if (!signature) return { ok: false, reason: "missing signature" };
  if (!timestamp) return { ok: false, reason: "missing timestamp" };

  if (!/^-?\d+$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skew > TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside window" };

  if (!signature.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: "malformed signature" };
  const hex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]*$/i.test(hex)) return { ok: false, reason: "malformed signature" };

  const provided = Buffer.from(hex, "hex");
  const expected = digest(secret, body);
  if (provided.length !== expected.length) return { ok: false, reason: "signature mismatch" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "signature mismatch" };

  return { ok: true };
}
