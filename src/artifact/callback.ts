import { sign } from "../auth/hmac.ts";
import type { Artifact } from "../types.ts";

export interface CallbackResult {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

const DEFAULT_BACKOFF_MS = [1000, 4000, 10_000];

/**
 * Deliver the artifact, HMAC-signed with the same secret the caller used to
 * dispatch. On final failure the actor keeps the artifact so the caller can
 * pull it from GET /jobs/:id/artifact.
 */
export async function deliverArtifact(
  url: string,
  artifact: Artifact,
  secret: string,
  opts: {
    attempts?: number;
    backoffMs?: readonly number[];
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CallbackResult> {
  const maxAttempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const body = JSON.stringify(artifact);
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...sign(secret, body) },
        body,
      });
      lastStatus = res.status;
      if (res.ok) return { delivered: true, attempts: attempt, lastStatus };
      // 4xx other than 408/429 won't succeed on retry — the caller rejected it.
      if (res.status < 500 && res.status !== 408 && res.status !== 429)
        return { delivered: false, attempts: attempt, lastStatus, lastError: `http ${res.status}` };
      lastError = `http ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < maxAttempts) await sleep(backoff[attempt - 1] ?? backoff.at(-1) ?? 1000);
  }

  return { delivered: false, attempts: maxAttempts, lastStatus, lastError };
}
