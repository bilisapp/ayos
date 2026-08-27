import { z } from "zod";

/** Job spec — the entire contract between a caller and Ayos. */
export const JobSpec = z.object({
  job_id: z.string().uuid(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be org/name"),
  base_ref: z.string().min(1),
  base_sha: z.string().regex(/^[0-9a-f]{7,40}$/, "base_sha must be a hex commit sha"),
  clone_token: z.string().min(1),
  llm_key: z.string().min(1),
  // Optional gateway override. It widens the VM's egress allowlist, so only the
  // caller (which mints llm_key and knows where it is valid) may set it.
  llm_host: z.string().regex(/^[a-z0-9.-]+$/i, "llm_host must be a bare hostname").optional(),
  task: z.object({
    instructions: z.string().min(1),
    context: z.string().default(""),
    links: z.array(z.string().url()).default([]),
  }),
  constraints: z
    .object({
      timeout_s: z.number().int().positive().max(3600).optional(),
      test_cmd: z.string().nullable().default(null),
      max_diff_lines: z.number().int().positive().default(800),
      path_denylist: z.array(z.string()).default([]),
    })
    .default({}),
  callback_url: z.string().url(),
});
export type JobSpec = z.infer<typeof JobSpec>;

export const JOB_STATES = [
  "queued",
  "cloning",
  "fixing",
  "testing",
  "packaging",
  "done",
  "failed",
  "cancelled",
  "timeout",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: readonly JobState[] = ["done", "failed", "cancelled", "timeout"];
export const isTerminal = (s: JobState): boolean => TERMINAL_STATES.includes(s);

export interface Artifact {
  job_id: string;
  status: Extract<JobState, "done" | "failed" | "cancelled" | "timeout">;
  diff: string | null;
  report: {
    summary: string;
    /** The failure, verbatim, when there was one — never the agent's prose. */
    error: string | null;
    files_touched: string[];
    tests: { cmd: string | null; passed: boolean | null; output_tail: string } | null;
    durations: { clone_ms: number; agent_ms: number; test_ms: number };
    links: string[];
  };
  events: unknown[];
}
