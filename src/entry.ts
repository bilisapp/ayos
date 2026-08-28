/**
 * The container entrypoint. One process, one job, then exit.
 *
 * There is no server here and no port. A Serverless Job run has no inbound
 * HTTP: the spec arrives as environment, the events go out in batches, the
 * artifact goes out once at the end, and the exit code is what the platform
 * records. Everything the old `index.ts` stood up — Hono, the actor registry,
 * the engine supervisor, the concurrency gate — belonged to a service that
 * stayed up, and none of it has a job to do in a process that does not.
 */
import { loadDotEnv } from "./env.ts";
import { loadJobSpec, scrubEnvironment, SpecError } from "./spec/load.ts";
import { loadSigningKey } from "./auth/sign.ts";
import { createAgentSessionFactory } from "./agent/provider.ts";
import { EventSink } from "./events/sink.ts";
import { deliverArtifact } from "./artifact/callback.ts";
import { runJob } from "./job/runner.ts";
import type { JobEvent, EventType } from "./events/schema.ts";
import type { JobSpec } from "./types.ts";

/** Default job budget when the spec does not set one. */
const DEFAULT_TIMEOUT_S = Number.parseInt(process.env.AYOS_DEFAULT_TIMEOUT_S ?? "900", 10);

loadDotEnv();

let spec: JobSpec;
try {
  spec = loadJobSpec();
} catch (err) {
  console.error(err instanceof SpecError ? err.message : String(err));
  process.exit(2);
}

// Everything sensitive is now in a local, and `process.env` is the environment
// the agent's `bash` inherits. Strip it before anything else can read it.
const scrubbed = scrubEnvironment();
if (scrubbed.length) console.log(`scrubbed ${scrubbed.length} credential(s) from the environment`);

const signingKey = loadSigningKey(spec.signing_key);

const sink = spec.events_url
  ? new EventSink({ url: spec.events_url, jobId: spec.job_id, key: signingKey })
  : null;

/** The authoritative transcript. The sink's copy is the live view of this. */
const transcript: JobEvent[] = [];
let seq = 0;

const emit = (type: EventType, data: Record<string, unknown>): void => {
  const event: JobEvent = { seq: ++seq, ts: new Date().toISOString(), type, data };
  transcript.push(event);
  sink?.push(event);
};

// A cancellation is the platform stopping this run. SIGTERM is the notice, and
// the runner's abort path turns it into a `cancelled` artifact — delivered, if
// there is time, so the caller learns the outcome rather than inferring it.
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`received ${signal} — cancelling`);
    controller.abort("cancelled");
  });
}

const artifact = await runJob(
  spec,
  {
    agents: createAgentSessionFactory(),
    defaultTimeoutS: Number.isFinite(DEFAULT_TIMEOUT_S) ? DEFAULT_TIMEOUT_S : 900,
    emit,
    onState: (next) => console.log(`phase: ${next}`),
  },
  controller.signal,
);

artifact.events = transcript;

const stats = sink ? await sink.close() : null;
if (stats && (stats.dropped || stats.failedFlushes))
  console.warn(
    `event sink: ${stats.sent} sent, ${stats.dropped} dropped, ${stats.failedFlushes} failed flushes`,
  );

const result = await deliverArtifact(spec.callback_url, artifact, signingKey);
if (result.delivered) {
  console.log(`artifact delivered (${artifact.status}) after ${result.attempts} attempt(s)`);
} else {
  console.error(
    `artifact NOT delivered after ${result.attempts} attempt(s): ${result.lastError ?? "unknown"}`,
  );
}

/*
 * The exit code is the only thing left that the caller can read without us.
 *
 *   0  the artifact reached the caller — the job's own status is inside it
 *   1  the job ran but the artifact could not be delivered; the caller sees a
 *      run that finished and never reported, and reconciles it as failed
 *   2  the run could not start at all (bad or missing spec)
 *
 * A red test suite is emphatically not a non-zero exit: it is a delivered
 * result, and exiting non-zero on it would make the platform's own retry
 * behaviour re-run somebody's failing suite forever.
 */
process.exit(result.delivered ? 0 : 1);
