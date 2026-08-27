import type { JobHost, JobSnapshot } from "./host.ts";
import type { JobSpec, Artifact, JobState } from "../types.ts";
import { isTerminal } from "../types.ts";
import type { JobEvent, JobStreamEvent } from "../events/schema.ts";
import { RingBuffer } from "../events/ringBuffer.ts";
import { runJob, type RunnerDeps } from "./runner.ts";
import { deliverArtifact } from "../artifact/callback.ts";

interface JobRecord {
  spec: JobSpec;
  snapshot: JobSnapshot;
  buffer: RingBuffer;
  subscribers: Set<(event: JobStreamEvent) => void>;
  abort: AbortController;
  artifact: Artifact | null;
  done: Promise<void>;
}

export interface InProcessHostDeps
  extends Pick<RunnerDeps, "sandboxes" | "agents" | "defaultTimeoutS"> {
  sharedSecret: string;
  ringCapacity?: number;
  /** How long a finished job stays readable via GET /jobs/:id/artifact. */
  retentionMs?: number;
  /** Injectable for tests; defaults to the real HMAC-signed POST. */
  deliver?: typeof deliverArtifact;
}

/**
 * Runs jobs in this process. Useful for local dev and tests, and the reference
 * for what the Rivet actor must do — the actor swaps the Map for actor state
 * and the subscriber Set for actor connections.
 */
/** One hour is comfortably longer than a caller's retry window for the pull path. */
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;

export class InProcessJobHost implements JobHost {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly reapers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: InProcessHostDeps) {}

  async start(spec: JobSpec): Promise<{ snapshot: JobSnapshot; created: boolean }> {
    const existing = this.jobs.get(spec.job_id);
    if (existing) return { snapshot: existing.snapshot, created: false };

    const record: JobRecord = {
      spec,
      snapshot: { job_id: spec.job_id, state: "queued", created_at: new Date().toISOString() },
      buffer: new RingBuffer(this.deps.ringCapacity ?? 2000),
      subscribers: new Set(),
      abort: new AbortController(),
      artifact: null,
      done: Promise.resolve(),
    };
    this.jobs.set(spec.job_id, record);
    record.done = this.execute(record);
    return { snapshot: record.snapshot, created: true };
  }

  private async execute(record: JobRecord): Promise<void> {
    const publish = (event: JobStreamEvent) => {
      for (const sub of record.subscribers) {
        try {
          sub(event);
        } catch {
          // A broken subscriber must never take the job down.
        }
      }
    };

    const emit = (
      type: JobEvent["type"],
      data: Record<string, unknown>,
      options: { durability?: "durable" | "ephemeral" } = {},
    ) => {
      if (options.durability === "ephemeral") {
        publish({ durability: "ephemeral", ts: new Date().toISOString(), type, data });
        return;
      }

      const event = record.buffer.push({ type, data });
      publish(event);
    };

    const artifact = await runJob(
      record.spec,
      {
        sandboxes: this.deps.sandboxes,
        agents: this.deps.agents,
        defaultTimeoutS: this.deps.defaultTimeoutS,
        emit,
        onState: (state: JobState) => {
          record.snapshot = { ...record.snapshot, state };
        },
      },
      record.abort.signal,
    );

    artifact.events = record.buffer.all();
    record.artifact = artifact;

    const deliver = this.deps.deliver ?? deliverArtifact;
    const callbackUrl = record.spec.callback_url;

    // The job is over, so the credentials it carried have no further use here.
    // Holding them costs nothing and buys an attacker a clone token and an LLM
    // key out of a heap dump.
    record.spec = { ...record.spec, clone_token: "", llm_key: "" };
    this.scheduleReap(record.snapshot.job_id);

    const result = await deliver(callbackUrl, artifact, this.deps.sharedSecret);
    if (!result.delivered) {
      // Keep it: the caller can pull from GET /jobs/:id/artifact.
      emit("error", {
        message: `callback delivery failed after ${result.attempts} attempts`,
        last_error: result.lastError,
        last_status: result.lastStatus,
      });
    }
  }

  /**
   * Drops a finished job after its retention window. Without this the map is a
   * leak: every job's spec, artifact and full event ring stays for the life of
   * the process.
   */
  private scheduleReap(jobId: string): void {
    const ms = this.deps.retentionMs ?? DEFAULT_RETENTION_MS;
    const timer = setTimeout(() => {
      this.reapers.delete(timer);
      const record = this.jobs.get(jobId);
      if (record && isTerminal(record.snapshot.state)) this.jobs.delete(jobId);
    }, ms);
    timer.unref?.();
    this.reapers.add(timer);
  }

  async get(jobId: string): Promise<JobSnapshot | null> {
    return this.jobs.get(jobId)?.snapshot ?? null;
  }

  async cancel(jobId: string): Promise<boolean> {
    const record = this.jobs.get(jobId);
    if (!record) return false;
    if (isTerminal(record.snapshot.state)) return true;
    record.abort.abort("cancelled");
    return true;
  }

  async artifact(jobId: string): Promise<Artifact | null> {
    return this.jobs.get(jobId)?.artifact ?? null;
  }

  async subscribe(
    jobId: string,
    afterSeq: number,
    onEvent: (event: JobStreamEvent) => void,
  ): Promise<(() => void) | null> {
    const record = this.jobs.get(jobId);
    if (!record) return null;

    // Replay first, then live. Both go through the same callback, so a client
    // reconnecting mid-job sees one continuous seq sequence.
    for (const event of record.buffer.since(afterSeq)) onEvent(event);
    record.subscribers.add(onEvent);
    return () => record.subscribers.delete(onEvent);
  }

  async activeCount(): Promise<number> {
    let n = 0;
    for (const record of this.jobs.values()) if (!isTerminal(record.snapshot.state)) n++;
    return n;
  }

  /** Test helper: wait for a job's pipeline (including callback) to settle. */
  async waitFor(jobId: string): Promise<void> {
    await this.jobs.get(jobId)?.done;
  }

  /**
   * Cancels every in-flight job and waits for each pipeline to unwind, which is
   * what actually disposes the sandboxes — and with them destroys the VM actors.
   * Shutdown must do this BEFORE the registry goes down: a live actor torn down
   * by the engine loses the race against its own final state persist and fails
   * with "SQLite transaction coordinator is closed".
   *
   * Bounded, because a wedged job (or a callback still retrying) must not hold
   * a tsx-watch restart hostage. On timeout the caller proceeds anyway.
   */
  async drain(timeoutMs: number): Promise<{ drained: boolean; pending: number }> {
    for (const timer of this.reapers) clearTimeout(timer);
    this.reapers.clear();

    const inFlight: Promise<void>[] = [];
    for (const record of this.jobs.values()) {
      if (isTerminal(record.snapshot.state)) continue;
      record.abort.abort("cancelled");
      inFlight.push(record.done);
    }
    if (inFlight.length === 0) return { drained: true, pending: 0 };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      const drained = await Promise.race([
        Promise.allSettled(inFlight).then(() => true as const),
        deadline,
      ]);
      return { drained, pending: inFlight.length };
    } finally {
      clearTimeout(timer);
    }
  }
}
