# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: native modules and the TypeScript build.
#
# agentOS pulls in three modules that compile from source — better-sqlite3
# (actor storage), isolated-vm (guest JS) and koffi (sidecar FFI) — so the build
# stage needs a full C++ toolchain. The runtime stage does not.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate

WORKDIR /app

# isolated-vm is a large C++ build. Left to itself node-gyp spawns one compiler
# job per core, and several concurrent v8 translation units will OOM a modest
# builder — which shows up as the daemon dying, not as a clean error.
ENV npm_config_jobs=1 \
    JOBS=1 \
    MAKEFLAGS=-j1

# Dependencies first, so a source-only change doesn't rebuild isolated-vm.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

# Drop dev dependencies. Runs after the build so tsc is still available above,
# and does not touch the already-compiled native modules.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm prune --prod

# ---------------------------------------------------------------------------
# Runtime stage.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# git is a RUNTIME dependency: agentOS has no working git, so Ayos clones on the
# host and mounts the checkout into the VM. Without git here, every job fails at
# the first phase.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/data

WORKDIR /app

# --chown on the COPY itself, never a `RUN chown -R` afterwards: rewriting the
# ownership of 1.6 GB of node_modules in a later layer duplicates every byte of
# it in the image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The engine keeps its database under $HOME; job checkouts land in TMPDIR.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 8080

# /healthz is the HTTP layer only. It answers before the engine is reachable, so
# the start period below has to cover the engine's boot rather than racing it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the engine child; without an init, a killed engine lingers as a
# zombie and the next start finds :6420 taken.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/scripts/serve.js"]
