import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-ayos-signature";
export const TIMESTAMP_HEADER = "x-ayos-timestamp";
export const SIGNATURE_PREFIX = "sha256=";
/** ±5 min replay window, per spec. */
export const TOLERANCE_SECONDS = 300;

/**
 * Two accepted schemes, because the caller (Bilis's `VerifyAyosSignature`) is a
 * separate deploy:
 *
 *   legacy — HMAC over the RAW BODY only, timestamp beside it in a header.
 *   bound  — HMAC over `timestamp.METHOD.path.body`.
 *
 * Legacy is replayable across endpoints whenever the body is empty: a captured
 * signature for `GET /jobs/A/artifact` verifies just as well for
 * `POST /jobs/B/cancel`. Bound fixes that by putting the method, the path and
 * the timestamp inside the MAC.
 *
 * `AYOS_HMAC_MODE=strict` accepts only bound signatures — flip it once the
 * caller signs that way. Default is `compat`, which accepts either.
 */
export type HmacMode = "compat" | "strict";

export function hmacModeFromEnv(env = process.env): HmacMode {
  return env.AYOS_HMAC_MODE === "strict" ? "strict" : "compat";
}

/** What a bound signature actually covers. Dots are separators, not escaping. */
export function canonicalString(
  timestamp: string,
  method: string,
  path: string,
  body: string,
): string {
  return `${timestamp}.${method.toUpperCase()}.${path}.${body}`;
}

function digest(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

export function nowSeconds(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Signs legacy (body-only) by default; pass `bind` to produce a bound
 * signature. The callback to Bilis stays legacy until that side is updated.
 */
export function sign(
  secret: string,
  body: string,
  timestamp = nowSeconds(),
  bind?: { method: string; path: string },
) {
  const payload = bind ? canonicalString(timestamp, bind.method, bind.path, body) : body;
  return {
    [SIGNATURE_HEADER]: SIGNATURE_PREFIX + digest(secret, payload).toString("hex"),
    [TIMESTAMP_HEADER]: timestamp,
  } as Record<string, string>;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyOptions {
  nowMs?: number;
  /** Method and path this request actually hit — required for bound signatures. */
  bind?: { method: string; path: string };
  /** `strict` rejects a legacy body-only signature. Default `compat`. */
  mode?: HmacMode;
}

export function verify(
  secret: string,
  body: string,
  headers: { signature?: string | null; timestamp?: string | null },
  opts: VerifyOptions | number = {},
): VerifyResult {
  const { nowMs = Date.now(), bind, mode = "compat" } =
    typeof opts === "number" ? { nowMs: opts } as VerifyOptions : opts;

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

  // Bound first: in compat mode a caller that already signs the canonical
  // string is verified as bound, and only an old caller falls through.
  const candidates: string[] = [];
  if (bind) candidates.push(canonicalString(timestamp, bind.method, bind.path, body));
  if (mode !== "strict" || !bind) candidates.push(body);

  for (const payload of candidates) {
    const expected = digest(secret, payload);
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(provided, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}
