# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Ayos runner: one container, one job, then exit.
#
# There is no server in here. The image is the body of a Serverless Job run:
# the spec arrives as environment, the job runs, the artifact is POSTed, the
# process exits, and the exit code is what the platform records. Nothing
# listens, so nothing needs a port, a health check or a volume.
#
# Nothing compiles from source any more either. The agentOS stack took
# better-sqlite3, isolated-vm and koffi with it, and with them the C++
# toolchain, the `MAKEFLAGS=-j1` OOM workaround and most of the build time.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

# Corepack asks for confirmation before downloading a package manager, and a
# prompt in a non-interactive build is a hang or a failure depending on the
# version. Answer it up front.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Dependencies first, so a source-only change does not refetch them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# The pnpm version comes from package.json's `packageManager` field, so CI and
# this image cannot drift apart by pinning it in two places.
RUN corepack prepare --activate
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

# Drop dev dependencies. After the build, so tsc is still available above.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm prune --prod

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# git is a RUNTIME dependency: Ayos clones the repository and computes the diff
# itself — the agent is never the one holding the pen that writes its own
# artifact. Without git here, every job fails at the first phase.
#
# `ca-certificates` for TLS to GitHub, the model provider and the callback.
# `tini` reaps whatever the agent's `bash` leaves behind: a run that ends with
# an orphaned child would otherwise keep PID 1 waiting.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# --chown on the COPY itself, never a `RUN chown -R` afterwards: rewriting the
# ownership of node_modules in a later layer duplicates every byte of it.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

# Deliberately absent: EXPOSE, HEALTHCHECK, VOLUME. A run has no inbound
# surface to expose, nothing to health-check between jobs, and nothing worth
# keeping when it exits.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/src/entry.js"]
