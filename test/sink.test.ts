import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EventSink } from "../src/events/sink.ts";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  loadSigningKey,
  publicKeyBase64,
  verifySignature,
} from "../src/auth/sign.ts";
import type { JobEvent } from "../src/events/schema.ts";

const SEED = Buffer.from(
  generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(16),
).toString("base64");
const KEY = loadSigningKey(SEED);
const PUBLIC_KEY = publicKeyBase64(KEY);

const JOB_ID = "6c4b0f9e-7a1d-4a3b-9f21-0d9a1c2e3f44";
const URL = "https://caller.test/events";

function event(seq: number): JobEvent {
  return { seq, ts: new Date(0).toISOString(), type: "phase", data: { state: "fixing" } };
}

interface Call {
  body: string;
  headers: Record<string, string>;
}

function stubFetch(statuses: (number | Error)[] = [200]) {
  const calls: Call[] = [];
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = statuses[calls.length - 1] ?? statuses.at(-1)!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function sinkWith(impl: typeof fetch, overrides: Partial<ConstructorParameters<typeof EventSink>[0]> = {}) {
  return new EventSink({ url: URL, jobId: JOB_ID, key: KEY, fetchImpl: impl, ...overrides });
}

describe("EventSink batching", () => {
  it("sends one signed batch containing every queued event", async () => {
    const { impl, calls } = stubFetch();
    const sink = sinkWith(impl);
    for (let i = 1; i <= 3; i++) sink.push(event(i));
    await sink.flush();

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0]!.body);
    expect(payload.job_id).toBe(JOB_ID);
    expect(payload.events.map((e: JobEvent) => e.seq)).toEqual([1, 2, 3]);
    expect(
      verifySignature(PUBLIC_KEY, calls[0]!.body, {
        signature: calls[0]!.headers[SIGNATURE_HEADER],
        timestamp: calls[0]!.headers[TIMESTAMP_HEADER],
      }),
    ).toBe(true);
  });

  it("flushes as soon as maxBatch is reached, without waiting for the timer", async () => {
    const { impl, calls } = stubFetch();
    // An hour-long timer: anything that arrives must have come from the count.
    const sink = sinkWith(impl, { maxBatch: 2, flushIntervalMs: 3_600_000 });
    sink.push(event(1));
    sink.push(event(2));
    await sink.flush();

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body).events).toHaveLength(2);
  });

  it("sends nothing when there is nothing queued", async () => {
    const { impl, calls } = stubFetch();
    await sinkWith(impl).flush();
    expect(calls).toHaveLength(0);
  });

  it("flushes on the timer", async () => {
    const { impl, calls } = stubFetch();
    const sink = sinkWith(impl, { flushIntervalMs: 10 });
    sink.push(event(1));

    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });
});

describe("EventSink is best-effort", () => {
  it("requeues a batch at the FRONT after a 500, so order survives a retry", async () => {
    const { impl, calls } = stubFetch([500, 200]);
    const sink = sinkWith(impl);
    sink.push(event(1));
    await sink.flush();
    sink.push(event(2));
    await sink.flush();

    expect(JSON.parse(calls[1]!.body).events.map((e: JobEvent) => e.seq)).toEqual([1, 2]);
  });

  it("drops a batch the caller rejected outright rather than retrying forever", async () => {
    const { impl, calls } = stubFetch([422, 200]);
    const sink = sinkWith(impl);
    sink.push(event(1));
    await sink.flush();
    sink.push(event(2));
    await sink.flush();

    expect(JSON.parse(calls[1]!.body).events.map((e: JobEvent) => e.seq)).toEqual([2]);
    expect(sink.snapshot().dropped).toBe(1);
  });

  it("requeues after a network error", async () => {
    const { impl, calls } = stubFetch([new Error("ECONNREFUSED"), 200]);
    const sink = sinkWith(impl);
    sink.push(event(1));
    await sink.flush();
    await sink.flush();

    expect(calls).toHaveLength(2);
    expect(sink.snapshot().failedFlushes).toBe(1);
  });

  /*
   * The invariant: a caller that stops answering must cost the job memory, not
   * the job. A long agent run with a dead events endpoint would otherwise grow
   * an unbounded array in a container sized for one job.
   */
  it("bounds the backlog by dropping the OLDEST events", async () => {
    const { impl, calls } = stubFetch([200]);
    const sink = sinkWith(impl, { maxQueue: 3, maxBatch: 1000, flushIntervalMs: 3_600_000 });
    for (let i = 1; i <= 10; i++) sink.push(event(i));
    await sink.flush();

    expect(JSON.parse(calls[0]!.body).events.map((e: JobEvent) => e.seq)).toEqual([8, 9, 10]);
    expect(sink.snapshot().dropped).toBe(7);
  });

  it("never lets a push throw, whatever the transport does", async () => {
    const impl = vi.fn(() => {
      throw new Error("transport exploded");
    }) as unknown as typeof fetch;
    const sink = sinkWith(impl, { maxBatch: 1 });

    expect(() => sink.push(event(1))).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  it("stops accepting events after close, and reports what was lost", async () => {
    const { impl, calls } = stubFetch([500]);
    const sink = sinkWith(impl);
    sink.push(event(1));

    const stats = await sink.close();
    expect(stats.dropped).toBe(1);

    sink.push(event(2));
    await sink.flush();
    expect(calls).toHaveLength(1);
  });

  it("reports what it managed to send", async () => {
    const { impl } = stubFetch([200]);
    const sink = sinkWith(impl);
    sink.push(event(1));
    sink.push(event(2));

    expect((await sink.close()).sent).toBe(2);
  });
});
