import type { KeyObject } from "node:crypto";
import { signRequest } from "../auth/sign.ts";
import type { JobEvent } from "./schema.ts";

export interface EventSinkOptions {
  url: string;
  jobId: string;
  key: KeyObject;
  /** Flush at least this often while events are pending. */
  flushIntervalMs?: number;
  /** Flush immediately once this many events are queued. */
  maxBatch?: number;
  /** Hard cap on the backlog. Beyond it the OLDEST events are dropped. */
  maxQueue?: number;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. A slow caller must not stall the job. */
  requestTimeoutMs?: number;
}

export interface EventSinkStats {
  sent: number;
  dropped: number;
  failedFlushes: number;
}

/**
 * Ships events to the caller while the job runs.
 *
 * The run has no inbound HTTP, so nothing can connect to it and watch — the
 * direction is inverted: Ayos POSTs batches and the caller does the fanning out
 * to browsers. That deletes the ring buffer, the SSE endpoint and the stream
 * JWT from this side entirely.
 *
 * **Best-effort, by construction.** Every failure mode here — the caller down,
 * slow, or rejecting — must cost the job nothing: the queue is bounded and
 * drops its oldest entries rather than growing, a failed flush is counted and
 * forgotten, and one request is in flight at a time so a slow caller cannot
 * multiply. The authoritative transcript is the `events` array in the artifact,
 * which is delivered once, with retries, at the end. This is the live view.
 */
export class EventSink {
  private readonly queue: JobEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly stats: EventSinkStats = { sent: 0, dropped: 0, failedFlushes: 0 };

  constructor(private readonly opts: EventSinkOptions) {}

  /** Queue one durable event. Never throws, never blocks the caller. */
  push(event: JobEvent): void {
    if (this.closed) return;

    const max = this.opts.maxQueue ?? 5000;
    if (this.queue.length >= max) {
      this.queue.shift();
      this.stats.dropped++;
    }
    this.queue.push(event);

    if (this.queue.length >= (this.opts.maxBatch ?? 50)) {
      void this.flush();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushIntervalMs ?? 1000);
      this.timer.unref?.();
    }
  }

  /** Send everything queued. Serialized: one POST in flight at a time. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.inFlight = this.inFlight.then(() => this.send());
    return this.inFlight;
  }

  private async send(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = JSON.stringify({ job_id: this.opts.jobId, events: batch });
    const doFetch = this.opts.fetchImpl ?? fetch;

    try {
      const res = await doFetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signRequest(this.opts.key, body),
        },
        body,
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 10_000),
      });
      if (res.ok) {
        this.stats.sent += batch.length;
        return;
      }
      this.stats.failedFlushes++;
      // A 4xx means the caller will not take this batch on a retry either;
      // anything else may be transient, so the events go back at the FRONT of
      // the queue to keep the transcript in order.
      if (res.status >= 500 || res.status === 408 || res.status === 429) this.requeue(batch);
      else this.stats.dropped += batch.length;
    } catch {
      this.stats.failedFlushes++;
      this.requeue(batch);
    }
  }

  private requeue(batch: JobEvent[]): void {
    const max = this.opts.maxQueue ?? 5000;
    this.queue.unshift(...batch);
    if (this.queue.length > max) {
      this.stats.dropped += this.queue.length - max;
      this.queue.splice(0, this.queue.length - max);
    }
  }

  /**
   * Final flush. Bounded: a caller that has stopped answering must not hold the
   * container open after the artifact has been delivered.
   */
  async close(timeoutMs = 5000): Promise<EventSinkStats> {
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        t.unref?.();
      }),
    ]);
    this.closed = true;
    this.stats.dropped += this.queue.length;
    this.queue.length = 0;
    return { ...this.stats };
  }

  snapshot(): EventSinkStats {
    return { ...this.stats };
  }
}
