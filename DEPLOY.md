# Deploying Ayos to Coolify

Ayos ships as a single container running two processes: the Rivet engine and the HTTP service.
`dist/scripts/serve.js` supervises both — if either dies, the container exits and Coolify restarts
it, rather than leaving something that still answers `/healthz` but can't run a job.

## Before you start

The spec asks for this, and it is worth honouring: **put Ayos on a different box from the caller's
production services.** It runs agent-authored code against attacker-influenceable input. The
sandbox and the egress allowlist are the containment, but blast radius is cheaper to limit than to
reason about.

## 1. Create the resource

In Coolify: **New Resource → Application → your git repository**, then set **Build Pack** to
`Dockerfile`. The `Dockerfile` at the repo root is picked up automatically; there is no build
command to configure.

Set the port to **8080**.

## 2. Environment variables

Generate them once with `pnpm keygen` (locally), then paste into Coolify's Environment Variables
tab. Do **not** commit a `.env` — in production these come from Coolify, and the built-in loader
is a no-op when no file is present.

| Variable | Value |
| --- | --- |
| `AYOS_SHARED_SECRET` | Must match the caller's `AUTOFIX_SHARED_SECRET` exactly. |
| `STREAM_JWT_PUBLIC_KEY` | The Ed25519 **public** half. Escaped newlines (`\n`) are fine. |
| `ALLOWED_ORIGIN` | The caller's browser origin, e.g. `https://app.example.tld`. |
| `PORT` | `8080` (already the image default). |
| `MAX_CONCURRENT_JOBS` | Start at `2–4` and raise once you've watched memory under load. |
| `DEFAULT_TIMEOUT_S` | `900`. |

There are deliberately **no LLM keys and no git credentials here** — both arrive per job, minted
by the caller and short-lived. If you find yourself wanting to add one, something has gone wrong.

Never set `AYOS_SKIP_EGRESS_CHECK` in production. It disables the per-job proof that the VM's
network policy is actually enforced.

## 3. Domain and TLS

Point a subdomain at it — `agents.example.tld` — and let Coolify's Traefik terminate TLS. Ayos
speaks plain HTTP on 8080 behind the proxy.

Two proxy settings matter for the event stream:

- **Disable response buffering** for `/jobs/*/stream`. A buffering proxy holds SSE frames until
  the response ends, which for a 15-minute job means the viewer sees nothing at all and then
  everything at once.
- **Raise the proxy read timeout** past `DEFAULT_TIMEOUT_S`. Ayos sends a `ping` event every 15
  seconds to keep the connection warm, but a proxy timeout shorter than a job will still cut long
  streams; clients reconnect and replay, so the symptom is a stutter rather than data loss.

## 4. Storage

Add a persistent volume mounted at **`/data`**. The engine keeps its database under `$HOME`, which
the image sets to `/data`. Without the volume a restart discards in-flight actor state — survivable
(the caller re-dispatches; `job_id` is idempotent) but noisy.

Job checkouts land in `/tmp` and are deleted when the job ends, so they need space but not
persistence. Size the disk for `MAX_CONCURRENT_JOBS` shallow clones plus headroom.

## 5. Health check

The image declares a `HEALTHCHECK` against `/healthz` with a 90-second start period — the engine
takes a while to finish its boot and backfills, and `/healthz` answers before the engine is
reachable, so a shorter start period will flap on deploy. If you configure Coolify's own health
check instead, use `GET /healthz` with the same generous start period.

## 6. Verify the deployment

```sh
curl https://agents.example.tld/healthz          # {"ok":true}

# Auth is live: an unsigned request must be refused.
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://agents.example.tld/jobs \
  -H 'content-type: application/json' -d '{}'    # 401
```

Then dispatch one real job from the caller and watch the phases. `pnpm sign --artifact <job_id>`
(pointed at the deployed URL via `AYOS_URL`) tells you whether a missing callback means the job
failed or the callback couldn't reach you.

## Resource sizing

Each concurrent job boots an agentOS VM in-process. Budget roughly **1 GB of RAM per concurrent
job** plus ~512 MB for the engine and Node itself, and give it at least 2 vCPU. `MAX_CONCURRENT_JOBS`
is the safety valve: above it Ayos returns `429` and the caller keeps the job queued — Ayos never
holds a backlog, so setting this conservatively costs latency, not work.

## Architecture

Coolify builds the image on the deploy host, so it produces whatever that host is — no
cross-building needed, and nothing in the Dockerfile is architecture-specific. If you instead build
locally on an Apple Silicon Mac and push, add `--platform linux/amd64` or you will ship an arm64
image to an x86 server. Note that emulated cross-builds recompile `isolated-vm` under QEMU and are
very slow; building on the target host is the easier path.

## Building the image yourself

```sh
docker build -t ayos:latest .
docker run --rm -p 8080:8080 \
  -e AYOS_SHARED_SECRET=… \
  -e STREAM_JWT_PUBLIC_KEY="$(cat pub.pem)" \
  -e ALLOWED_ORIGIN=https://app.example.tld \
  -v ayos-data:/data \
  ayos:latest
```

The build compiles `isolated-vm`, `better-sqlite3` and `koffi` from source, which is the slow part
(several minutes on a cold cache) and needs real memory. It is pinned to a single compile job
(`MAKEFLAGS=-j1`): parallel v8 translation units will exhaust a modest builder, and the failure
shows up as the Docker daemon dying rather than as a readable error. If your Coolify host is small,
build elsewhere and deploy the image, or give the builder more RAM.

`git` is installed in the runtime image on purpose — agentOS has no working git, so Ayos clones on
the host and mounts the checkout into the VM. Without it every job fails at the first phase.
