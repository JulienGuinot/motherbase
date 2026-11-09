# Shared dependency image: installs the full workspace node_modules ONCE,
# including the expensive native addons (argon2). Both the API image
# (Dockerfile) and the Console image (apps/server/console/Dockerfile) derive from
# this, so the native compile happens a single time instead of once per image.
#
# Build context is the repo root:
#   docker build -t motherbase-deps:1.0.0 -f deploy/deps.Dockerfile .
FROM node:22-bookworm-slim
WORKDIR /app
# openssl/ca-certificates: Prisma engine + TLS. python3/make/g++: native addons.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Copy every workspace manifest (+ the root preinstall guard) before installing so
# the layer caches on lockfile changes only. npm needs each workspace package.json
# present to resolve and link the workspace tree.
COPY package.json package-lock.json ./
COPY scripts/check-node-version.cjs ./scripts/
COPY apps/server/package.json ./apps/server/
COPY apps/studio/package.json ./apps/studio/
COPY packages/ai/package.json ./packages/ai/
COPY packages/cli/package.json ./packages/cli/
COPY packages/client/package.json ./packages/client/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/create-app/package.json ./packages/create-app/
COPY packages/ssr/package.json ./packages/ssr/
COPY packages/ui/package.json ./packages/ui/
# --mount=type=cache keeps npm's cache across rebuilds (needs BuildKit).
RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps
