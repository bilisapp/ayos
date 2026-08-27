import type { JobHost, JobSnapshot } from "./host.ts";
import type { JobSpec, Artifact, JobState } from "../types.ts";
import { isTerminal } from "../types.ts";
import type { JobEvent } from "../events/schema.ts";
import { RingBuffer } from "../events/ringBuffer.ts";
import { runJob, type RunnerDeps } from "./runner.ts";
import { deliverArtifact } from "../artifact/callback.ts";

interface JobRecord {
  spec: JobSpec;
  snapshot: JobSnapshot;
  buffer: RingBuffer;
  subscribers: Set<(event: JobEvent) => void>;
  abort: AbortController;
  artifact: Artifact | null;
  done: Promise<void>;
}

export interface InProcessHostDeps
  extends Pick<RunnerDeps, "sandboxes" | "agents" | "defaultTimeoutS"> {
  sharedSecret: string;
  ringCapacity?: number;
  /** Injectable for tests; defaults to the real HMAC-signed POST. */
  deliver?: typeof deliverArtifact;
}

/**
 * Runs jobs in this process. Useful for local dev and tests, and the reference
 * for what the Rivet actor must do — the actor swaps the Map for actor state
 * and the subscriber Set for actor connections.
 */
export class InProcessJobHost implements JobHost {
  private readonly jobs = new Map<string, JobRecord>();

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
    const emit = (type: JobEvent["type"], data: Record<string, unknown>) => {
      const event = record.buffer.push({ type, data });
      for (const sub of record.subscribers) {
        try {
          sub(event);
        } catch {
          // A broken subscriber must never take the job down.
        }
      }
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
    const result = await deliver(record.spec.callback_url, artifact, this.deps.sharedSecret);
    if (!result.delivered) {
      // Keep it: the caller can pull from GET /jobs/:id/artifact.
      emit("error", {
        message: `callback delivery failed after ${result.attempts} attempts`,
        last_error: result.lastError,
        last_status: result.lastStatus,
      });
    }
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
    onEvent: (event: JobEvent) => void,
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
}
