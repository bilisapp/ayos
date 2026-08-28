<p align="center">
  <img src="./ayos.png" alt="Ayos" width="360" />
</p>

# ayos

Single-purpose execution service: it takes a job spec, runs a coding agent against a repository,
and returns a diff plus a structured report. It never pushes to a git remote — the caller owns
the write path.

One job is one container run. There is no server, no port and nothing listening.

## Quick start

```sh
pnpm install
pnpm test                    # 244 tests, no network, no container
pnpm keygen                  # an Ed25519 keypair, for local runs
pnpm run:local ./job.json    # run one job exactly as the container does
```

## How a job runs

```
start a run, spec in the environment
  → clone at base_sha, then REVOKE the clone token
  → Pi (SDK, in-process) works in the checkout, event batches POST to the caller
  → optional test_cmd, diff packaged, denylist enforced
  → signed artifact POSTed to the caller; the container exits
```

The caller starts the run through its platform's API and mints an Ed25519 keypair for it: the
private half goes into the run, the public half stays on the caller's job record. Everything the
run posts back is signed with it. There is no shared secret and no inbound authentication,
because there is nothing to authenticate *to*.

## Reusing it

Ayos was built to power an autofix pipeline, but nothing in it knows what an autofix is. The job
spec is `instructions + repo in, diff + report out`, and that is the whole integration surface.
There is no SDK and no shared queue: a caller is one API call to start a run and one webhook
handler, in any language that can verify an Ed25519 signature.

[`examples/translate-readme.mjs`](./examples/translate-readme.mjs) is a complete caller in under a
hundred dependency-free lines. It asks the agent for a Spanish translation of a repo's README and
leaves the diff on disk for `git apply` — a task with nothing bug-shaped about it, driven through
the same contract Bilis uses:

```sh
GITHUB_TOKEN=... ANTHROPIC_API_KEY=... \
node examples/translate-readme.mjs org/repo main <base-sha>
```

The simplicity is the safety model. Because the artifact is only ever a diff, the blast radius of
a misbehaving agent is capped at "a patch you haven't applied": Ayos holds no write credentials,
pushes nothing, and the container is gone when the job ends. Every policy question (who may run
jobs, what gets published where, when to retry) stays in the caller.

## Three things worth knowing

**The clone token is single-use.** It enters the same container as the agent, so it is revoked the
moment the clone finishes — before the agent's first tool call. A caller that caches installation
tokens across jobs must stop doing that for the token it hands to Ayos.

**The repository does not get to write the system prompt.** Pi normally discovers `AGENTS.md`,
`.pi/skills/*` and extensions from the working directory. The working directory here is untrusted
input, so all of that discovery is turned off. There is a test that plants a hostile `AGENTS.md`
and asserts it never reaches the model.

**There is no egress control.** agentOS gave each job a deny-by-default network policy; a
serverless container has no equivalent, and a proxy is defeated by the agent having `bash`. So a
prompt-injected agent can reach arbitrary hosts for the life of one job. That is accepted and
stated rather than papered over — see SPEC.md. The run is ephemeral and single-tenant, and the
credential that could do lasting damage is already dead by then.

**`test_cmd` needs a runtime the image does not have.** It carries git and Node. A `test_cmd`
needing php, python or ruby fails the job with an explicit message; use `test_cmd: null` and
verify the patch in your CI.

## Docs

| Doc | What's in it |
| --- | --- |
| [SPEC.md](./SPEC.md) | The full design: job spec, artifact shape, event schema, invariants |
| [RUNNING.md](./RUNNING.md) | Running a job locally, wiring a Laravel caller |
| [DEPLOY.md](./DEPLOY.md) | Building the image and wiring up Scaleway Serverless Jobs |

## Non-goals

Pushing branches, opening PRs, storing repos or job history, knowing any caller's domain
vocabulary, retrying the task itself, or being a service. See SPEC.md.
