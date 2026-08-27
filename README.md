# ayos

Single-purpose execution service: it takes a signed job spec, runs a coding agent against a
repository inside an isolated VM, and returns a **diff + structured report**. It never pushes to a
git remote — the caller owns the write path.

See [SPEC.md](./SPEC.md) for the full design. This README covers what exists and how to run it.

## Quick start

```sh
pnpm install
cp .env.example .env    # set AYOS_SHARED_SECRET at minimum
pnpm test               # unit suite (no VM required)
pnpm dev
```

## Layout

| Path | What it does |
| --- | --- |
| `src/index.ts` | Process entry: config → host → HTTP server |
| `src/http/app.ts` | Hono app: `/jobs`, `/jobs/:id/cancel`, `/jobs/:id/artifact`, `/jobs/:id/stream`, `/healthz` |
| `src/job/runner.ts` | The lifecycle state machine — provision → clone → agent → test → package → callback |
| `src/job/host.ts` | The `JobHost` interface the HTTP layer talks to |
| `src/job/inProcessHost.ts` | In-process `JobHost` (dev/tests); the Rivet actor is the durable one |
| `src/sandbox.ts` | The narrow VM surface (`exec`/`writeFile`/`dispose`) + egress allowlist derivation |
| `src/agent/prompt.ts` | Safety-invariant system prompt and the nonce-fenced untrusted-context block |
| `src/agent/session.ts` | The coding-agent interface the runner drives |
| `src/auth/hmac.ts` | Control-plane signing/verification (both directions) |
| `src/auth/streamJwt.ts` | Ed25519 verification for browser stream tokens (verify only — Ayos never mints) |
| `src/events/` | Event schema, ring buffer, secret redaction |
| `src/git/clone.ts` | Host-side shallow clone at a pinned sha via one-shot `GIT_ASKPASS`; the checkout is mounted into the VM |
| `src/artifact/` | Diff packaging, test run, denylist enforcement, signed callback with retries |

## Calling it

Every control-plane request is signed over the **raw body**, with the timestamp bound into the
signed payload (`{timestamp}.{body}`) and a ±5 minute window:

```
X-Ayos-Signature: sha256=<hex hmac>
X-Ayos-Timestamp: <ISO 8601>
```

`src/auth/hmac.ts` exports `sign()` — a caller in another language reproduces it as
`HMAC-SHA256(secret, timestamp + "." + rawBody)`.

Browser stream tokens are Ed25519 JWTs minted by the caller with claims
`{ sub, job, scope: "stream:read", exp }`. Ayos holds only the public key. `exp` is checked at
connect time only; an established stream is not killed when the token expires.

## Status

- Core modules, HTTP layer, lifecycle state machine, prompt safety, auth, redaction: **done**.
- agentOS VM and Pi session adapters: **done**, built against the shipped type definitions and
  verified against a live VM. Not yet exercised end-to-end with real credentials.
- Durable Rivet job actor: **not started** — `InProcessJobHost` implements the same `JobHost`
  interface, so it is a swap rather than a rewrite.

### Two constraints worth knowing before you read the code

**Pi has no system-prompt channel.** `additionalInstructions` never reaches the model, so Ayos's
safety invariants ride at the head of the first user turn. The nonce fence around untrusted
context still does the real separation work.

**The VM has no git and no language runtimes.** The clone therefore happens on the host and is
mounted in — which also keeps the clone token out of the VM entirely. A `test_cmd` needing php,
node or python fails the job with an explicit message; use `test_cmd: null` and verify in CI.

## Non-goals

Pushing branches, opening PRs, storing repos or job history, knowing any caller's domain
vocabulary, or retrying the task itself. See SPEC.md.
