# Running Ayos locally

Everything below is verified on macOS arm64, Node 24, pnpm 11.

## 1. Install

```sh
pnpm install
pnpm test
```

No engine to start, no key to configure, no `.env` to fill in. There is no service: `pnpm test`
is the whole setup, and it takes about ten seconds.

## 2. Make a job spec

```sh
pnpm keygen
```

That prints two lines: a `public_key` for the caller to keep, and a `signing_key` to put in the
spec. In production these are minted **per job** — this exists so a local run has something to
sign with.

```sh
cat > /tmp/job.json <<'JSON'
{
  "job_id": "3f7c1e2a-0000-4000-8000-000000000001",
  "repo": "your-org/your-app",
  "base_ref": "main",
  "base_sha": "<a real 40-char sha on that branch>",
  "clone_token": "ghs_…",
  "llm_provider": "anthropic",
  "llm_key": "sk-ant-…",
  "signing_key": "<from pnpm keygen>",
  "task": {
    "instructions": "Fix the failing assertion in tests/Feature/ExampleTest.php.",
    "context": "",
    "links": []
  },
  "constraints": {
    "timeout_s": 900,
    "test_cmd": null,
    "max_diff_lines": 800,
    "path_denylist": [".github/**", ".env*"]
  },
  "callback_url": "http://localhost:8125/artifact",
  "events_url": "http://localhost:8125/events"
}
JSON

pnpm run:local /tmp/job.json
```

`pnpm run:local` runs `src/entry.ts` with the spec in `AYOS_JOB_SPEC` — the same code path, the
same environment variable, the same everything as the container. A job that works here is a job
that works in a run.

You need something listening on `callback_url`. `examples/translate-readme.mjs` is a complete one
(and starts the run itself); for a bare receiver, anything that returns 2xx will do — the run
does not care what you do with the artifact, only that you took it.

**`test_cmd` should be `null` for a Laravel app.** The image carries git and Node. A `test_cmd`
needing php, python or ruby fails the job immediately with a message saying so; let your CI verify
the patch instead.

## 3. Reading the output

The run logs its phases to stdout and nothing else — no transcript, no secrets:

```
phase: cloning
phase: fixing
phase: packaging
phase: done
artifact delivered (done) after 1 attempt(s)
```

Everything interesting is in the artifact and the event batches. If the callback never arrives,
the exit code tells you which half failed: `1` means the job ran and the delivery did not, `2`
means the spec was wrong.

---

# Wiring a Laravel caller

The Bilis side of this is built, and the class names below are real ones — `AyosClient`,
`RunKeyPair`, `RunDriver` with a `LocalRunDriver` and a `ScalewayRunDriver`, `FixJobEventRecorder`,
`FixJobStreamController`. The local driver spawns this runner as a child process, which is how the
whole path is exercised without a container registry in the loop.

## Starting a run

There is no Ayos endpoint to call. The control plane starts a run — a child process locally, a
Serverless Job run in production — and puts the spec in that run's environment:

```php
// 1. One keypair for this job. Keep the public half; never keep the private one.
$seed      = random_bytes(SODIUM_CRYPTO_SIGN_SEEDBYTES);
$keypair   = sodium_crypto_sign_seed_keypair($seed);
$publicKey = base64_encode(sodium_crypto_sign_publickey($keypair));

$job->forceFill(['ayos_public_key' => $publicKey])->save();

// 2. The spec, with the private half inside it.
$spec = json_encode([
    'job_id'       => $job->uuid,
    'repo'         => $repository->repo_full_name,
    'base_ref'     => $repository->default_branch,
    'base_sha'     => $baseSha,
    'clone_token'  => $cloneToken,          // see the warning below
    'llm_provider' => $credential->provider->value,   // which provider the key is for
    'llm_key'      => $credential->key,
    'llm_host'     => $credential->host(),
    'signing_key'  => base64_encode($seed),
    'task'         => $taskRenderer->render($job),
    'constraints'  => [...],
    'callback_url' => route('api.internal.autofix.artifacts'),
    'events_url'   => route('api.internal.autofix.events'),
], JSON_UNESCAPED_SLASHES);

// 3. Start the run, and RECORD ITS ID — it is the only handle you have afterwards.
$runId = $this->runs->start($spec, $job->uuid);   // RunDriver: local or scaleway
$job->forceFill(['ayos_run_id' => $runId])->save();
```

The public key goes on the row **before** the run starts. A run can post its first event batch
within a second of starting, and a callback arriving before its own verification key is a 401 on a
perfectly good job.

> **The clone token is now single-use.** Ayos revokes it the moment the clone finishes, because it
> enters the same container as the agent. `GitHubAppTokenService` caches read-only installation
> tokens for 50 minutes and shares them between call sites, so the Ayos call site passes
> `fresh: true` — without it the next job is dispatched with a credential the previous run
> destroyed, and the failure reads as a permissions problem rather than a caching one.

## Verifying what comes back

Same signed string as before — `{timestamp}.{raw body}` — with Ed25519 instead of HMAC, and the
key looked up per job:

```php
$raw       = $request->getContent();
$timestamp = (string) $request->header('X-Ayos-Timestamp', '');
$provided  = (string) $request->header('X-Ayos-Signature', '');

if (! ctype_digit($timestamp) || abs(now()->getTimestamp() - (int) $timestamp) > 300) {
    abort(401, 'stale timestamp');
}
if (! str_starts_with($provided, 'ed25519=')) {
    abort(401, 'bad signature');
}

// The job id comes out of an UNVERIFIED body — parse it, use it only to find
// the key, and trust nothing else until the signature checks out.
$jobId = json_decode($raw, true)['job_id'] ?? null;
$job   = FixJob::query()->where('uuid', $jobId)->firstOrFail();

$valid = sodium_crypto_sign_verify_detached(
    base64_decode(substr($provided, strlen('ed25519='))),
    $timestamp.'.'.$raw,
    base64_decode($job->ayos_public_key),
);
abort_unless($valid, 401, 'bad signature');
```

Use the same check on both the artifact route and the new events route.

**Re-validate the diff on your side.** Ayos enforces `path_denylist` and `max_diff_lines`, but a
patch produced by an agent that read attacker-influenced context is not something to apply on
trust. `DiffValidator` already does this and should keep doing it.

## The event stream

Ayos no longer serves browsers. It POSTs batches of events to `events_url` and Laravel fans them
out — which means `StreamTokenIssuer` now guards a Laravel route rather than an Ayos one, and the
CORS and `exp`-at-connect-time subtleties are gone with the endpoint they belonged to.

```php
// POST /api/internal/autofix/events   { job_id, events: [{ seq, ts, type, data }, ...] }
// Append by `seq`, ignoring anything you already have: batches can arrive
// twice or out of order, and the artifact carries the authoritative copy anyway.
```

Delivery is best-effort by design: a run whose events endpoint is down still finishes, still
delivers its artifact, and the artifact's `events` array is complete. Never treat a gap in the
live stream as a failed job.

## Reconciling a run that never answered

Two signals, and you need both — see DEPLOY.md §5. `StaleFixJobReaper` already fails anything
unanswered after `timeout_s + 10 minutes`; polling the run status for those jobs turns "eventually
declared lost" into "known failed", and distinguishes a crashed run from a slow one.

---

# Full-circle checklist

1. `pnpm test` — 244 green.
2. Build and push the image; create the job definition (DEPLOY.md §1–2).
3. `pnpm run:local` with a **real** `base_sha`, a repo-scoped `clone_token` and `test_cmd: null` —
   this proves the spec and the callback before the platform is involved.
4. Start one run from Laravel and watch the phases arrive on the events route.
5. Confirm the diff applies: `git apply --check` against `base_sha`.
6. Kill a run mid-flight and confirm you get a `cancelled` artifact, or that the reaper catches it.

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| Run exits `2` immediately | Spec missing or invalid. The message names the field. |
| Run exits `1` | The job ran; the callback could not be delivered. Check `callback_url` from inside the run's network, not from your laptop. |
| `401` on the callback | Verifying against the wrong job's public key, or re-encoding the body before verifying. Sign and verify the raw bytes. |
| `clone failed` | `clone_token` lacks repo read scope, is expired, or was already revoked — a cached token from a previous job is the likely one. |
| `test_cmd requires …` | The image has no language runtimes. Use `test_cmd: null`. |
| Job fails with `model … is not in the anthropic catalog` | `AYOS_PI_MODEL` names a model the pinned SDK does not know. Bump the SDK or pick a known id — it fails loudly on purpose rather than silently using a different model. |
| `exec format error` at start | An arm64 image on x86-64. Build with `--platform linux/amd64`. |
