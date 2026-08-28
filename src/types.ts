import { z } from "zod";

/** Job spec — the entire contract between a caller and Ayos. */
export const JobSpec = z.object({
  job_id: z.string().uuid(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo must be org/name"),
  base_ref: z.string().min(1),
  base_sha: z.string().regex(/^[0-9a-f]{7,40}$/, "base_sha must be a hex commit sha"),
  clone_token: z.string().min(1),
  /**
   * Which provider `llm_key` authenticates against. The caller holds the key
   * and is therefore the only party that knows where it is valid — a runner
   * that guessed would send a customer's OpenRouter token to Anthropic.
   *
   * Defaults to `anthropic`, which is what every spec meant before this field
   * existed.
   */
  llm_provider: z.enum(["anthropic", "openai", "openrouter"]).default("anthropic"),
  llm_key: z.string().min(1),
  // Optional host override: the hostname the provider is reached at. The
  // caller sets it to route model traffic through its own gateway; left out,
  // the provider's own default host is used.
  llm_host: z.string().regex(/^[a-z0-9.-]+$/i, "llm_host must be a bare hostname").optional(),
  /**
   * Ed25519 private key for THIS run, base64. The caller keeps the public half
   * on its own job record and verifies everything this run posts back with it.
   * There is no shared secret any more: a leaked key authenticates one job.
   *
   * Either shape libsodium hands an operator is accepted — the 32-byte seed or
   * the 64-byte secret key — matching Bilis's StreamTokenIssuer, so an operator
   * cannot paste the wrong one of the two.
   */
  signing_key: z.string().min(1),
  task: z.object({
    instructions: z.string().min(1),
    context: z.string().default(""),
    links: z.array(z.string().url()).default([]),
  }),
  constraints: z
    .object({
      timeout_s: z.number().int().positive().max(86400).optional(),
      test_cmd: z.string().nullable().default(null),
      max_diff_lines: z.number().int().positive().default(800),
      path_denylist: z.array(z.string()).default([]),
    })
    .default({}),
  /** Where the finished artifact is POSTed. */
  callback_url: z.string().url(),
  /**
   * Where event batches are POSTed while the job runs. Optional: without it the
   * run is silent until the artifact lands, which is a supported (if dull) mode.
   */
  events_url: z.string().url().optional(),
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
  /**
   * The full transcript. Event batches are also POSTed live to `events_url`,
   * but that path is best-effort: this copy is the authoritative one, and it is
   * what the caller should persist.
   */
  events: unknown[];
}
