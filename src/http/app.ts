import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config.ts";
import type { JobHost } from "../job/host.ts";
import { JobSpec } from "../types.ts";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "../auth/hmac.ts";
import { verifyStreamToken } from "../auth/streamJwt.ts";
import type { JobStreamEvent } from "../events/schema.ts";

export interface AppDeps {
  config: Config;
  host: JobHost;
}

export function createApp({ config, host }: AppDeps): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  /**
   * Reads the body with a hard byte cap. The signature cannot be checked until
   * the bytes are in hand, so this read is unauthenticated: without a cap an
   * anonymous POST decides how much memory the process allocates. Content-Length
   * is a hint (it can lie, or be absent under chunked encoding), so the stream
   * is counted as it arrives too.
   */
  const readBody = async (req: Request, limit: number): Promise<string | null> => {
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > limit) return null;
    if (!req.body) return "";

    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  /**
   * Control-plane guard. Reads the RAW body — the signature covers bytes, not a
   * re-serialized object — and binds the MAC to this request's method and path,
   * so a captured empty-body signature cannot be replayed onto another job id
   * or another endpoint. See `auth/hmac.ts` for the compat/strict modes.
   */
  const withHmac = async (c: Context) => {
    const body = await readBody(c.req.raw, config.maxBodyBytes);
    if (body === null) return { body: "", tooLarge: true as const, result: null };

    const result = verify(config.sharedSecret, body, {
      signature: c.req.header(SIGNATURE_HEADER),
      timestamp: c.req.header(TIMESTAMP_HEADER),
    }, {
      bind: { method: c.req.method, path: new URL(c.req.url).pathname },
      mode: config.hmacMode,
    });
    return { body, tooLarge: false as const, result };
  };

  app.post("/jobs", async (c) => {
    const { body, tooLarge, result } = await withHmac(c);
    if (tooLarge) return c.json({ error: "payload too large" }, 413);
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401);

    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const parsed = JobSpec.safeParse(json);
    if (!parsed.success)
      return c.json({ error: "invalid job spec", issues: parsed.error.issues }, 422);

    // Idempotency is checked before backpressure: a retry of an accepted job
    // must not be rejected with 429 just because the box is now busy.
    const existing = await host.get(parsed.data.job_id);
    if (existing) return c.json({ job_id: existing.job_id, state: existing.state }, 202);

    if ((await host.activeCount()) >= config.maxConcurrentJobs)
      return c.json({ error: "at capacity", retry: true }, 429);

    const { snapshot } = await host.start(parsed.data);
    return c.json({ job_id: snapshot.job_id, state: snapshot.state }, 202);
  });

  app.post("/jobs/:id/cancel", async (c) => {
    const { tooLarge, result } = await withHmac(c);
    if (tooLarge) return c.json({ error: "payload too large" }, 413);
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401);

    const cancelled = await host.cancel(c.req.param("id"));
    if (!cancelled) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true }, 202);
  });

  app.get("/jobs/:id/artifact", async (c) => {
    const { tooLarge, result } = await withHmac(c);
    if (tooLarge) return c.json({ error: "payload too large" }, 413);
    if (!result.ok) return c.json({ error: "unauthorized", reason: result.reason }, 401);

    const artifact = await host.artifact(c.req.param("id"));
    if (!artifact) return c.json({ error: "not ready" }, 404);
    return c.json(artifact);
  });

  app.get("/jobs/:id/stream", async (c) => {
    const jobId = c.req.param("id");
    const origin = c.req.header("origin");

    // CORS headers go on every response — errors included — so a browser
    // surfaces the real status ("origin not allowed", "unauthorized") instead
    // of reporting every failure as a missing-CORS-header mystery.
    if (config.allowedOrigin) {
      c.header("Access-Control-Allow-Origin", config.allowedOrigin);
      c.header("Vary", "Origin");
    }

    if (!config.streamJwtPublicKey)
      return c.json({ error: "streams not configured" }, 503);
    if (origin && config.allowedOrigin && origin !== config.allowedOrigin)
      return c.json({ error: "origin not allowed" }, 403);

    const token = c.req.query("token");
    if (!token) return c.json({ error: "missing token" }, 401);

    const auth = await verifyStreamToken(config.streamJwtPublicKey, token, jobId);
    if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

    const afterSeq = Number.parseInt(c.req.header("last-event-id") ?? c.req.query("after") ?? "0", 10) || 0;

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;
      let closed = false;
      const queue: JobStreamEvent[] = [];
      let notify: (() => void) | null = null;

      stream.onAbort(() => {
        closed = true;
        unsubscribe?.();
        notify?.();
      });

      unsubscribe = await host.subscribe(jobId, afterSeq, (event) => {
        queue.push(event);
        notify?.();
      });
      if (!unsubscribe) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "unknown job" }) });
        return;
      }

      while (!closed) {
        while (queue.length) {
          const event = queue.shift()!;
          await stream.writeSSE({
            ...("seq" in event ? { id: String(event.seq) } : {}),
            event: event.type,
            data: JSON.stringify(event),
          });
          // `exp` is enforced at connect time only — an in-flight stream is
          // never killed mid-job; clients reconnect with a fresh token.
          if (event.type === "done") {
            closed = true;
            unsubscribe?.();
            return;
          }
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 15_000);
        }).then(() => {
          notify = null;
        });
        if (!closed && !queue.length) await stream.writeSSE({ event: "ping", data: "" });
      }
    });
  });

  return app;
}
