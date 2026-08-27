import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-ayos-signature";
export const TIMESTAMP_HEADER = "x-ayos-timestamp";
/** ±5 min replay window, per spec. */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/** Signed payload binds the timestamp to the body so a capture can't be replayed later. */
function payload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

export function sign(secret: string, body: string, timestamp = new Date().toISOString()) {
  const mac = createHmac("sha256", secret).update(payload(timestamp, body)).digest("hex");
  return {
    [SIGNATURE_HEADER]: `sha256=${mac}`,
    [TIMESTAMP_HEADER]: timestamp,
  } as Record<string, string>;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(
  secret: string,
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
  now = Date.now(),
): VerifyResult {
  const { signature, timestamp } = headers;
  if (!signature) return { ok: false, reason: "missing signature" };
  if (!timestamp) return { ok: false, reason: "missing timestamp" };

  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return { ok: false, reason: "malformed timestamp" };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "timestamp outside window" };

  const expected = createHmac("sha256", secret).update(payload(timestamp, body)).digest();
  const [algo, hex] = signature.split("=", 2);
  if (algo !== "sha256" || !hex) return { ok: false, reason: "malformed signature" };

  let provided: Buffer;
  try {
    provided = Buffer.from(hex, "hex");
  } catch {
    return { ok: false, reason: "malformed signature" };
  }
  if (provided.length !== expected.length) return { ok: false, reason: "signature mismatch" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}
