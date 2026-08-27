import type { JobSpec, Artifact, JobState } from "../types.ts";
import type { JobEvent } from "../events/schema.ts";

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
   * Replay events after `afterSeq`, then live ones. The returned function
   * unsubscribes.
   */
  subscribe(
    jobId: string,
    afterSeq: number,
    onEvent: (event: JobEvent) => void,
  ): Promise<(() => void) | null>;
  activeCount(): Promise<number>;
}
