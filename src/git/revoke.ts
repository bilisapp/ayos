/**
 * Kills the clone token the moment the clone is done.
 *
 * In the agentOS design the token never entered the VM at all — the clone
 * happened on the host and only the checkout was mounted. One container per job
 * takes that away: the token arrives in the same process the agent's `bash`
 * runs under. The replacement is time, not isolation. The token is used, then
 * revoked, and the agent's first tool call happens after it is already dead.
 *
 * Best-effort by design. A failed revocation is reported and the job continues:
 * the token is `contents: read`, scoped to one repository, and expires within
 * the hour on its own. Failing the job over it would trade a small residual
 * risk for a large certain one.
 *
 * NOTE FOR THE CALLER: this makes the token single-use. A control plane that
 * caches installation tokens across jobs (Bilis caches read-only ones for 50
 * minutes) must stop caching the token it hands to Ayos, or the next job will
 * be dispatched with one this run already destroyed.
 */

export const GITHUB_API_URL = "https://api.github.com";

export interface RevokeResult {
  revoked: boolean;
  status?: number;
  error?: string;
}

export async function revokeCloneToken(
  token: string,
  opts: { apiUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RevokeResult> {
  const apiUrl = opts.apiUrl ?? process.env.AYOS_GITHUB_API_URL ?? GITHUB_API_URL;
  const doFetch = opts.fetchImpl ?? fetch;

  try {
    const res = await doFetch(`${apiUrl.replace(/\/$/, "")}/installation/token`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    // 204 is the documented success. 401 means the token is already invalid,
    // which is the outcome we wanted anyway.
    return { revoked: res.status === 204 || res.status === 401, status: res.status };
  } catch (err) {
    return { revoked: false, error: err instanceof Error ? err.message : String(err) };
  }
}
