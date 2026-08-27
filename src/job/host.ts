import type { JobSpec, Artifact, JobState } from "../types.ts";
import type { JobStreamEvent } from "../events/schema.ts";

export interface JobSnapshot {
  job_id: string;
  state: JobState;
  created_at: string;
}

/**
 * What the HTTP layer needs from whatever runs jobs. The Rivet actor registry
 * is one implementation; an in-process host (dev, tests) is another.
 */
export interface JobHost {
  /** Idempotent: a repeat job_id returns the existing job without restarting it. */
  start(spec: JobSpec): Promise<{ snapshot: JobSnapshot; created: boolean }>;
  get(jobId: string): Promise<JobSnapshot | null>;
  cancel(jobId: string): Promise<boolean>;
  artifact(jobId: string): Promise<Artifact | null>;
  /**
   * Replay durable events after `afterSeq`, then live events. Ephemeral live
   * deltas are never replayed. The returned function unsubscribes.
   */
  subscribe(
    jobId: string,
    afterSeq: number,
    onEvent: (event: JobStreamEvent) => void,
  ): Promise<(() => void) | null>;
  activeCount(): Promise<number>;
}
