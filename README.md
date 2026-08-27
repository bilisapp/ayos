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
else (`/jobs`, `/jobs/:id/cancel`, `/jobs/:id/artifact`) is server-to-server, HMAC-signed:
`HMAC-SHA256(secret, rawBody)` over the raw body only, with the timestamp riding beside it as
`X-Ayos-Timestamp` inside a ±5 minute window.

## Reusing it

Ayos was built to power an autofix pipeline, but nothing in it knows what an autofix is — the
job spec is `instructions + repo in, diff + report out`, and that is the whole integration
surface. No SDK, no queue to share, no schema to extend: a caller is one signed POST and one
webhook handler, in any language that has HMAC.

[`examples/translate-readme.mjs`](./examples/translate-readme.mjs) is a complete caller in under
a hundred dependency-free lines. It asks the agent for a Spanish translation of a repo's README
and leaves the diff on disk for `git apply` — a task with nothing bug-shaped about it, driven
through exactly the same four endpoints Bilis uses:

```sh
AYOS_URL=http://localhost:8080 AYOS_SHARED_SECRET=... \
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... \
node examples/translate-readme.mjs org/repo main <base-sha>
```

The simplicity is the safety model, not a convenience. Because the artifact is *only ever a
diff*, the blast radius of a misbehaving agent is capped at "a patch you haven't applied":
Ayos holds no write credentials, pushes nothing, and forgets the VM when the job ends. Every
policy question — who may run jobs, what gets published where, when to retry — stays in the
caller, where it belongs. Swap the instructions and the same executor becomes a codemod runner,
a docs bot, or a nightly dependency-note writer, with zero new code on this side of the HMAC.

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
