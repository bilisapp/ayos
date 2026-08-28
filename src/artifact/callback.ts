import type { KeyObject } from "node:crypto";
import { signRequest } from "../auth/sign.ts";
import type { Artifact } from "../types.ts";

export interface CallbackResult {
  delivered: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

const DEFAULT_BACKOFF_MS = [1000, 4000, 10_000];

/**
 * Deliver the artifact, signed with this run's Ed25519 key.
 *
 * This is the only thing the caller is actually waiting for, and the run has
 * nowhere to keep it: there is no `GET /jobs/:id/artifact` any more, because
 * there is no server. So the retries here are the first line, and the caller
 * reconciling a finished-but-silent run against the platform's run status is
 * the second. Between them, a job never disappears quietly.
 */
export async function deliverArtifact(
  url: string,
  artifact: Artifact,
  key: KeyObject,
  opts: {
    attempts?: number;
    backoffMs?: readonly number[];
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    requestTimeoutMs?: number;
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
      // Signed per attempt, not once: the timestamp is inside the signature and
      // the caller enforces a freshness window, so a signature minted before a
      // ten-second backoff has to be minted again after it.
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...signRequest(key, body) },
        body,
        signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 30_000),
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
