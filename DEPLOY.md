# Deploying Ayos to Scaleway Serverless Jobs

Ayos is not a service. There is nothing to keep running, nothing to health-check and no domain to
point at it. Deployment is three things: an image in a registry, a job definition that runs it, and
a caller that starts one run per job.

Everything below is checked against the published `v1alpha2` OpenAPI schema
(`https://www.scaleway.com/en/developers/api/serverless-jobs/v1alpha2/schema.yml`). The paths moved
between alpha versions and a wrong one returns a 404 that reads exactly like a deleted job
definition, so `ScalewayRunDriver` pins them and `ScalewayRunDriverTest` asserts them.

## 0. What the run needs to reach

Sanity-check this before anything else, because a run has no inbound surface and cannot be
debugged interactively:

- **`github.com`** — the shallow clone.
- **`api.github.com`** — revoking the clone token straight after the clone.
- **Your model provider** (`api.anthropic.com`, or your gateway).
- **Your control plane**, for the event batches and the artifact. **This is the one people miss.**
  If Bilis is only reachable inside a VPN or on `localhost`, every run will finish, fail to deliver,
  and exit `1`. The callback URL is generated from `APP_URL`, so that must be a hostname the run can
  actually resolve.

## 1. Build and push the image

`.github/workflows/image.yml` does this on every push to `main` and every `v*` tag: it runs the
test suite, builds for `linux/amd64`, and pushes to Scaleway Container Registry. Pull requests
build without pushing, so a broken Dockerfile fails on the PR rather than on a deploy.

Configure it once, under **Settings → Secrets and variables → Actions**:

| | Name | Value |
| --- | --- | --- |
| Secret | `SCW_SECRET_KEY` | An API secret key with `ContainerRegistryFullAccess` (add `ServerlessJobsFullAccess` to use the job-definition step below) |
| Variable | `SCW_REGISTRY_NAMESPACE` | Your registry namespace, e.g. `bilis` — create it first, the registry will not invent one |
| Variable | `SCW_REGION` | Optional, defaults to `fr-par` |
| Variable | `SCW_JOB_DEFINITION_ID` | Optional; only needed for the job-definition step |

Images are tagged `sha-<commit>` always, `v1.2.3` on a version tag, and `latest` on every push to
`main`. Note that a version tag does **not** move `latest`: it means "newest build", not "newest
release". The workflow also prints the resulting `…/ayos@sha256:…` digest in its run summary.

Which of those a job definition should point at is a real choice, and both are defensible:

- **Pinned** (`…/ayos@sha256:…`, or `:v1.2.3`) — a run always uses the image that was tested, and
  deploying is an explicit act. This is what the workflow's job-definition step does.
- **`:latest`** — set the definition's `image_uri` once and never touch it again; every run pulls
  whatever `latest` currently points at, so merging to `main` deploys. Simpler, at the cost of a
  run being able to pick up an image nobody deliberately shipped. If you want this, skip the
  job-definition step entirely rather than letting the two fight over the field.

By hand, if you would rather:

```sh
docker build --platform linux/amd64 -t rg.fr-par.scw.cloud/<namespace>/ayos:<tag> .
docker login rg.fr-par.scw.cloud -u nologin -p "$SCW_SECRET_KEY"
docker push rg.fr-par.scw.cloud/<namespace>/ayos:<tag>
```

`--platform linux/amd64` is not optional on an Apple Silicon machine. Serverless Jobs run x86-64,
and an arm64 image fails at start with an exec-format error. The workflow states the platform
explicitly for the same reason, so moving to arm runners fails in CI rather than in a container you
cannot attach to.

`latest` is fine as a convenience for `docker run` and for a definition you want to track `main`.
What it cannot give you is a record of what a particular run actually executed — which is why every
build is also tagged `sha-<commit>` and the digest is printed in the run summary.

The build itself is ordinary now: nothing compiles from source since the agentOS stack (and with it
`better-sqlite3`, `isolated-vm` and `koffi`) was removed, so there is no C++ toolchain, no
`MAKEFLAGS=-j1` OOM workaround, and no multi-minute native build.

## 2. Understand where the credentials go

There is one platform constraint that shapes everything else, so it is worth stating plainly.

**Scaleway has no per-run secret channel.** `POST …/job-definitions/{id}/start` accepts only a plain
`environment_variables` string map. Secret references do exist, but they attach to a job
*definition* and point at a static Secret Manager entry — so they can carry what is identical for
every job, and nothing that varies per job.

Ayos's job spec varies per job in every field, the model credential included:

| Credential | Lifetime | Blast radius if read from a run record |
| --- | --- | --- |
| Clone token | Revoked by the run seconds after cloning | `contents: read` on one repository, already dead |
| Per-run signing key | One job, minutes | Forging that job's artifact — the diff still faces `DiffValidator` and human PR review |
| **LLM key** | Per customer, scoped and budgeted | **Spend, up to that customer's remaining budget** |
| Task instructions/context | One job | Whatever the caller put in it |

So nothing goes in Secret Manager. The whole spec travels as one plain per-run environment
variable, and the security argument is that every credential in it is scoped and short-lived enough
for that to be acceptable.

> **The LLM key is the one to think hardest about**, because it is the only item on that list that
> can cost money rather than merely propose a patch. A per-customer token with a spend cap bounds
> the damage to that cap; a shared organisation-wide key would not, and must not be used here. If
> the token can additionally be minted per job and expire with it, the exposure window shrinks from
> "the retention period of the run record" to "the length of one job", and this stops being a
> question worth agonising over.
>
> Everything on that table is readable from the Scaleway console and API by anyone with project read
> access, for as long as the run record is retained. If that is not acceptable for your threat
> model, see **Hardening: fetch the spec instead of injecting it** at the end.

## 3. Create the job definition

```sh
scw jobs definition create \
  name=ayos \
  image-uri=rg.fr-par.scw.cloud/<namespace>/ayos:<tag> \
  cpu-limit=1000 \
  memory-limit=2048 \
  job-timeout=1h \
  local-storage-capacity=4096 \
  region=fr-par
```

Field notes, from the schema:

- **`cpu_limit`** is in mvCPU (`1000` = 1 vCPU), **`memory_limit`** and **`local_storage_capacity`**
  in MiB.
- **Sizing.** One job, one container, and the agent runs in-process — there is no VM to budget a
  gigabyte for any more. 1 vCPU / 2 GB is a sane start. The memory that matters is a large diff plus
  the transcript, not the runtime. `local_storage_capacity` has to hold a shallow clone of the
  largest repository you point it at, with headroom.
- **`job_timeout`** must exceed the largest `constraints.timeout_s` any caller will ask for. The
  platform's ceiling is 24 h, and the spec schema rejects anything past that so the two cannot
  disagree.
- **`retry_policy`: leave it at zero retries.** A failing test suite is a delivered result, not a
  failed run — but a run that genuinely dies has already burned an LLM call and possibly published
  events. Re-dispatch is the control plane's decision, not the platform's.
- **No `environment_variables` on the definition at all.** Everything the runner needs arrives per
  run, because everything it needs varies per job.
- **No `cron_schedule`.** Runs are started by the caller, one per job.

## 4. Start a run

This is what `ScalewayRunDriver::start()` does:

```
POST https://api.scaleway.com/serverless-jobs/v1alpha2/regions/fr-par/job-definitions/{id}/start
X-Auth-Token: $SCW_SECRET_KEY
Content-Type: application/json

{ "environment_variables": { "AYOS_JOB_SPEC": "<the spec, as JSON>" } }
```

The response's `id` is the run id. **Record it on your job row** — it is the only handle you have
afterwards, for cancellation and for reconciling a run that died without reporting.

### Rolling the definition forward

The workflow's third job PATCHes `image_uri` on an existing definition, pinned by **digest** rather
than tag. It runs automatically on a `v*` tag, and on demand from the Actions tab
("Run workflow" → *Point the Scaleway job definition at the image this run builds*). It is opt-in
because pushing an image is safe, while changing what every subsequent job runs is a deployment.

Runs already in flight keep the image they started with. A run is one job and it is over in
minutes, so there is nothing to drain.

Point Bilis at it:

```
AUTOFIX_RUNNER_DRIVER=scaleway
AUTOFIX_SCW_JOB_DEFINITION_ID=<definition id>
SCW_SECRET_KEY=<api secret key>
SCW_REGION=fr-par
```

The API key needs `ServerlessJobsFullAccess` (start, stop, read runs) — nothing else.

## 5. Cancellation

`POST /job-runs/{run_id}/stop`. The container gets `SIGTERM`, the runner treats it as a
cancellation, aborts the agent and still tries to deliver a `cancelled` artifact so the caller
learns the outcome rather than inferring it. A 404 means the run is already gone, which is what
cancellation wanted — the driver treats it as success.

## 6. Reconciliation — the part that is easy to skip

A run can die without saying anything: OOM-killed mid-package, hard-stopped, or unable to reach the
callback at all. The runner retries the artifact three times with backoff and then exits non-zero,
so the caller needs both signals:

- **the artifact**, the normal path; and
- **the run state**, `GET /job-runs/{run_id}`, polled for any job past its start-up grace.

The documented `state` enum is `unknown_state`, `initialized`, `validated`, `queued`, `running`,
`succeeded`, `failed`, `interrupting`, `interrupted`, `retrying`. Only `succeeded`, `failed` and
`interrupted` mean nothing more is coming. **Classify unknown states as alive**, not dead: a state
Scaleway adds later must not fail every job in flight, and the deadline still catches anything
genuinely stuck.

Exit codes, which the run's `exit_code` field surfaces:

| Code | Meaning |
| --- | --- |
| `0` | The artifact reached the caller. The job's own status is inside it. |
| `1` | The job ran; the artifact could not be delivered. |
| `2` | The run could not start — a missing or invalid spec. |

A failing test suite is emphatically **not** a non-zero exit. It is a delivered result, and exiting
non-zero on it would make any retry policy re-run somebody's failing suite forever.

## 7. What is deliberately absent

No domain, no TLS termination, no proxy buffering settings, no persistent volume, no
`MAX_CONCURRENT_JOBS`, no `/healthz`. Concurrency belongs to the platform and back-pressure to the
caller's queue.

## Environment reference

Everything below is optional and none of it is a secret.

| Variable | Value |
| --- | --- |
| `AYOS_JOB_SPEC` / `AYOS_JOB_SPEC_FILE` | The job spec, including the per-job LLM key. Set per run, by the caller. |
| `AYOS_DEFAULT_TIMEOUT_S` | Budget when the spec sets no `timeout_s`. Default `900`. |
| `AYOS_PI_MODEL` | Model id. Must exist in the pinned SDK's catalog; an unknown id fails the run loudly rather than falling back. |
| `AYOS_GITHUB_API_URL` | GitHub Enterprise only — where the clone token is revoked. |

If you find yourself wanting to add a credential here, something has gone wrong. There are no
long-lived secrets in this deployment.

## Hardening: fetch the spec instead of injecting it

The residual risk in §2 comes entirely from the spec being a plain run variable, and the platform
gives no way to avoid that for per-job values. It can be removed without changing the architecture:

1. The caller stores the spec server-side and starts the run with one short-lived, single-use
   **fetch token** as the only environment variable.
2. The runner exchanges that token for the real spec over TLS at startup, and the caller invalidates
   it on first use.

Nothing sensitive ever lands on a run record, and the exposure window becomes the seconds before the
runner redeems the token rather than the retention period of the run. It also sidesteps environment
variable size limits, which a large `task.context` can reach. The cost is one endpoint on the caller
and one round trip at startup — and the runner already has to reach the caller, so it adds no new
network dependency.

This matters more the longer-lived the per-customer LLM token is. If those tokens are minted per job
and expire with it, injecting the spec directly is defensible on its own; if they are long-lived
per-customer keys sitting in your database, this is the difference between "a leak costs one job"
and "a leak costs a customer's budget".

## Running the image by hand

```sh
docker run --rm -e AYOS_JOB_SPEC="$(cat job.json)" ayos:latest
```

Useful for confirming that git, the network path to GitHub and the callback URL all work from
wherever you are running it, before wiring the platform in.
