import { describe, expect, it, vi } from "vitest";
import { GITHUB_API_URL, revokeCloneToken } from "../src/git/revoke.ts";

const TOKEN = "ghs_CloneTokenThatMustDie0123456789";

function stub(response: number | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return new Response(null, { status: response });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("revokeCloneToken", () => {
  it("DELETEs /installation/token as the token itself", async () => {
    const { impl, calls } = stub(204);
    const res = await revokeCloneToken(TOKEN, { fetchImpl: impl });

    expect(res.revoked).toBe(true);
    expect(calls[0]!.url).toBe(`${GITHUB_API_URL}/installation/token`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  /*
   * 401 means the token is already invalid — which is the outcome we wanted.
   * Reporting that as a failed revocation would put a scary line in every job's
   * events for a credential that is, in fact, dead.
   */
  it("treats an already-invalid token as revoked", async () => {
    expect((await revokeCloneToken(TOKEN, { fetchImpl: stub(401).impl })).revoked).toBe(true);
  });

  it("reports a refusal without throwing", async () => {
    const res = await revokeCloneToken(TOKEN, { fetchImpl: stub(403).impl });
    expect(res).toEqual({ revoked: false, status: 403 });
  });

  it("reports a network failure without throwing", async () => {
    const res = await revokeCloneToken(TOKEN, {
      fetchImpl: stub(new Error("ECONNREFUSED")).impl,
    });
    expect(res.revoked).toBe(false);
    expect(res.error).toBe("ECONNREFUSED");
  });

  it("honours a GitHub Enterprise API root", async () => {
    const { impl, calls } = stub(204);
    await revokeCloneToken(TOKEN, { fetchImpl: impl, apiUrl: "https://ghe.example.test/api/v3/" });
    expect(calls[0]!.url).toBe("https://ghe.example.test/api/v3/installation/token");
  });
});
