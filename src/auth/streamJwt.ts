import { importSPKI, jwtVerify, type JWTPayload, type KeyLike } from "jose";

export const STREAM_SCOPE = "stream:read";
const ALG = "EdDSA";

export interface StreamClaims extends JWTPayload {
  sub: string;
  job: string;
  scope: string;
}

/**
 * Ayos holds only the public key: it can verify stream tokens, never mint them.
 * Accepts PEM (`-----BEGIN PUBLIC KEY-----`) or bare base64 DER.
 */
export async function loadPublicKey(raw: string): Promise<KeyLike> {
  const trimmed = raw.trim();
  const pem = trimmed.includes("BEGIN")
    ? trimmed.replace(/\\n/g, "\n")
    : `-----BEGIN PUBLIC KEY-----\n${trimmed.replace(/\s+/g, "").replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----`;
  return importSPKI(pem, ALG);
}

export type StreamAuthResult =
  | { ok: true; claims: StreamClaims }
  | { ok: false; reason: string };

/**
 * `exp` is enforced at connect time only — an established stream is never killed
 * mid-flight; clients reconnect with a fresh token.
 */
export async function verifyStreamToken(
  key: KeyLike,
  token: string,
  jobId: string,
): Promise<StreamAuthResult> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, { algorithms: [ALG] }));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "invalid token" };
  }
  if (payload.scope !== STREAM_SCOPE) return { ok: false, reason: "wrong scope" };
  if (typeof payload.job !== "string" || payload.job !== jobId)
    return { ok: false, reason: "token not valid for this job" };
  if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "missing sub" };
  return { ok: true, claims: payload as StreamClaims };
}
