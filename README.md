<p align="center">
  <img src="./ayos.png" alt="Ayos" width="360" />
</p>

# ayos

Single-purpose execution service: it takes a signed job spec, runs a coding agent against a
repository inside an isolated VM, and returns a **diff + structured report**. It never pushes to
a git remote — the caller owns the write path.

## Quick start

```sh
pnpm install
pnpm keygen             # prints .env blocks for Ayos and for the caller
pnpm test               # unit suite, no VM required
pnpm dev                # rivet engine + ayos on :8080
```

## How a job runs

```
POST /jobs (HMAC-signed spec)
  → clone on the host, mount into a fresh agentOS VM
  → agent session (Pi) works inside the VM, events stream over SSE
  → optional test_cmd, diff packaged, denylist enforced
  → signed artifact callback to the caller; VM destroyed
```

The browser can watch a job live at `GET /jobs/:id/stream` with an Ed25519 token the **caller**
mints (`{ sub, job, scope: "stream:read", exp }`) — Ayos holds only the public key. Everything
else (`/jobs`, `/jobs/:id/cancel`, `/jobs/:id/artifact`) is server-to-server, HMAC-signed over
the raw body with the timestamp bound in: `HMAC-SHA256(secret, timestamp + "." + rawBody)`,
±5 minute window.

## Two constraints worth knowing before you read the code

**Pi has no system-prompt channel.** `additionalInstructions` never reaches the model, so Ayos's
safety invariants ride at the head of the first user turn. The nonce fence around untrusted
context still does the real separation work.

**The VM has no git and no language runtimes.** The clone therefore happens on the host and is
mounted in — which also keeps the clone token out of the VM entirely. A `test_cmd` needing php,
node or python fails the job with an explicit message; use `test_cmd: null` and verify in CI.

## Docs

| Doc | What's in it |
| --- | --- |
| [SPEC.md](./SPEC.md) | The full design: job spec, artifact shape, event schema, invariants |
| [RUNNING.md](./RUNNING.md) | Local-dev walkthrough, wiring a Laravel caller, full-circle checklist |
| [DEPLOY.md](./DEPLOY.md) | Building and running it in production |

## Non-goals

Pushing branches, opening PRs, storing repos or job history, knowing any caller's domain
vocabulary, or retrying the task itself. See SPEC.md.
