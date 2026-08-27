# Running Ayos locally

Everything below is verified on macOS arm64, Node 24, pnpm 11.

## 1. Install and generate keys

```sh
pnpm install
pnpm keygen
```

`pnpm keygen` prints two blocks: one for Ayos's `.env`, one for the caller's. Copy them across.
Ayos gets the **public** key only — it can verify stream tokens but never mint them.

Ayos `.env`:

```
PORT=8080
AYOS_SHARED_SECRET=<from keygen>
STREAM_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"
ALLOWED_ORIGIN=http://localhost                 # your Laravel app's origin
MAX_CONCURRENT_JOBS=4
DEFAULT_TIMEOUT_S=900
```

No LLM key and no git credentials here — those arrive per job.

## 2. Start it

```sh
pnpm dev
```

That starts the Rivet engine, waits for it to be genuinely healthy, then starts Ayos with
file-watching. You should see:

```
[dev] starting rivet engine…
[dev] engine healthy
[dev] starting ayos…
ayos listening on :8080
```

Check it: `curl localhost:8080/healthz` → `{"ok":true}`

Two terminals instead, if you prefer:

```sh
pnpm engine                              # terminal 1
AYOS_EXTERNAL_ENGINE=1 pnpm dev:server   # terminal 2
```

> **Why the engine runs separately.** rivetkit 2.3.9 can start its own engine, but its health
> check gives up before the engine finishes booting on macOS arm64, and the process then retries
> `failed to fetch metadata` forever without ever serving actors. `pnpm dev` sidesteps this. If you
> ever see that message repeating, a stale engine is probably holding `:6420` — `pkill -f
> rivet-engine` and retry.

## 3. Send a job without writing any caller code

```sh
cat > /tmp/job.json <<'JSON'
{
  "job_id": "3f7c1e2a-0000-4000-8000-000000000001",
  "repo": "your-org/your-app",
  "base_ref": "main",
  "base_sha": "<a real 40-char sha on that branch>",
  "clone_token": "ghs_…",
  "llm_key": "sk-ant-…",
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
  "callback_url": "http://host.docker.internal:8000/api/ayos/artifacts"
}
JSON

AYOS_SHARED_SECRET=<secret> pnpm sign /tmp/job.json
```

`pnpm sign` signs the exact bytes it sends, prints the equivalent `curl`, and POSTs it. Also:

```sh
pnpm sign /tmp/job.json --print       # headers + curl only, don't send
pnpm sign --cancel   <job_id>
pnpm sign --artifact <job_id>         # pull the artifact if the callback failed
```

**`test_cmd` should be `null` for a Laravel app.** The agentOS guest ships coreutils, grep, sed,
gawk, findutils, tar and gzip — no PHP, node or python. A `test_cmd` needing one of those fails
the job immediately with a message saying so. Let your CI verify the patch instead.

---

# Wiring a Laravel caller

## Signing a request to Ayos

The signature covers `{timestamp}.{rawBody}` — the raw bytes, not a re-encoded array.

```php
$body = json_encode($jobSpec, JSON_UNESCAPED_SLASHES);
$timestamp = now()->utc()->toIso8601ZuluString('millisecond');   // e.g. 2026-08-27T11:35:40.728Z
$signature = hash_hmac('sha256', $timestamp . '.' . $body, config('services.ayos.secret'));

$response = Http::withHeaders([
    'Content-Type'      => 'application/json',
    'X-Ayos-Signature'  => 'sha256=' . $signature,
    'X-Ayos-Timestamp'  => $timestamp,
])->withBody($body, 'application/json')->post(config('services.ayos.url') . '/jobs');

// 202 => { job_id, state }   429 => at capacity, keep it queued and retry
```

The timestamp must be within ±5 minutes of Ayos's clock. A repeat `job_id` returns the existing
job rather than starting a second one, so retrying a timed-out dispatch is safe.

## Verifying the artifact callback

Ayos signs the callback with the **same secret**, the same way. Verify before trusting it:

```php
Route::post('/api/ayos/artifacts', function (Request $request) {
    $raw       = $request->getContent();
    $timestamp = $request->header('X-Ayos-Timestamp', '');
    $provided  = $request->header('X-Ayos-Signature', '');

    if (abs(now()->timestamp - strtotime($timestamp)) > 300) {
        abort(401, 'stale timestamp');
    }

    $expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $raw, config('services.ayos.secret'));
    if (! hash_equals($expected, $provided)) {
        abort(401, 'bad signature');
    }

    $artifact = json_decode($raw, true);
    // $artifact['status']  done | failed | cancelled | timeout
    // $artifact['diff']    unified diff against base_sha — apply it yourself, Ayos never pushes
    // $artifact['report']  summary, files_touched, tests, durations, links
    // $artifact['events']  full transcript, for your persisted record

    return response()->noContent();
});
```

Use `hash_equals`, not `===`. Ayos retries 3× with backoff on 5xx/408/429 and gives up on other
4xx, so return 2xx only once you've actually stored it. If every attempt fails, the artifact stays
retrievable from `GET /jobs/:id/artifact`.

**Re-validate the diff on your side.** Ayos enforces `path_denylist` and `max_diff_lines`, but the
spec has the caller check too — a patch produced by an agent that read attacker-influenced context
is not something to apply on trust.

## Minting a stream token for the browser

Ed25519, ~10 minute expiry, scoped to one job. Requires `firebase/php-jwt`:

```php
use Firebase\JWT\JWT;

$keypair = sodium_crypto_sign_seed_keypair(base64_decode(config('services.ayos.stream_seed')));
$secret  = base64_encode(sodium_crypto_sign_secretkey($keypair));

$token = JWT::encode([
    'sub'   => (string) auth()->id(),   // viewer id, for audit
    'job'   => $jobId,                  // the ONE job this token may watch
    'scope' => 'stream:read',
    'exp'   => time() + 600,
], $secret, 'EdDSA');
```

`AYOS_STREAM_JWT_SEED` is the base64 seed `pnpm keygen` printed. Ayos rejects the token if `job`
doesn't match the URL, if `scope` is wrong, or if it's expired — and it only ever holds the public
key, so a compromised Ayos still can't mint one.

## Consuming the stream

```js
const es = new EventSource(`${AYOS_URL}/jobs/${jobId}/stream?token=${token}`);
es.addEventListener('phase',         e => console.log('phase',  JSON.parse(e.data).data.state));
es.addEventListener('agent_message', e => append(JSON.parse(e.data).data.text));
es.addEventListener('tool_call',     e => console.log('tool',   JSON.parse(e.data).data.title));
es.addEventListener('done',          e => es.close());
```

On connect Ayos replays the ring buffer, then streams live. `EventSource` sends `Last-Event-ID`
automatically on reconnect, so a dropped connection resumes from the last `seq` rather than
replaying everything.

`exp` is checked **at connect time only** — a stream that's already open isn't killed when the
token expires. Mint a fresh one per connection attempt. Set `ALLOWED_ORIGIN` to your Laravel
origin or the browser will be refused.

---

# Full-circle checklist

1. `pnpm keygen`, split the output into both `.env` files.
2. `pnpm dev` — wait for `ayos listening on :8080`.
3. `curl localhost:8080/healthz` → `{"ok":true}`.
4. Expose your Laravel callback URL to Ayos. Same machine: `http://localhost:8000/…` works.
5. Dispatch a job with a **real** `base_sha`, a repo-scoped `clone_token`, and `test_cmd: null`.
6. Watch `pnpm dev`'s output for the phase transitions: `cloning → fixing → packaging → done`.
7. Confirm your callback fired and the diff applies: `git apply --check` against `base_sha`.

If the callback never arrives, pull it directly — `pnpm sign --artifact <job_id>` — which
distinguishes "the job failed" from "the callback couldn't reach you".

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| `failed to fetch metadata` on repeat | Stale engine on `:6420`. `pkill -f rivet-engine`, restart. |
| `401 unauthorized` / `signature mismatch` | Signed a re-encoded body instead of the raw bytes, or clock skew > 5 min. |
| `422 invalid job spec` | Response lists the exact failing fields — `base_sha` must be hex, `repo` must be `org/name`. |
| `429 at capacity` | More than `MAX_CONCURRENT_JOBS` in flight. Keep it queued caller-side; Ayos holds no backlog. |
| Job fails with `test_cmd requires …` | The VM has no language runtimes. Use `test_cmd: null`. |
| Job fails with `egress allowlist is not being enforced` | The sandbox isn't containing network access. Investigate before running anything real — do not set `AYOS_SKIP_EGRESS_CHECK=1` to get past it except against a VM you trust. |
| Clone fails with an auth error | `clone_token` needs repo read scope and must not be expired. |
