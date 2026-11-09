#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DOCKER_BUILDKIT=1

# Shared deps first: native addons (argon2) compiled once, reused
# by both the API and Console images. See deploy/deps.Dockerfile.
docker build -t motherbase-deps:1.0.0 -f "$REPO_ROOT/deploy/deps.Dockerfile" "$REPO_ROOT"
docker build -t "${API_IMAGE:-motherbase-api:1.0.0}" -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
docker build -t "${CONSOLE_IMAGE:-motherbase-console:1.0.0}" -f "$REPO_ROOT/apps/server/console/Dockerfile" "$REPO_ROOT"
docker build --build-arg CONSOLE_IMAGE="${CONSOLE_IMAGE:-motherbase-console:1.0.0}" --build-arg DOCKER_CLI_IMAGE="${DOCKER_CLI_IMAGE:-docker:27-cli}" -t "${ORCHESTRATION_IMAGE:-motherbase-orchestrator:1.0.0}" -f "$REPO_ROOT/apps/server/console/Orchestration.Dockerfile" "$REPO_ROOT"
docker build -t motherbase-postgres:1.0.0 -f "$REPO_ROOT/deploy/postgres.Dockerfile" "$REPO_ROOT"
docker build -t "${EDGE_RUNTIME_IMAGE:-motherbase-edge-runtime:1.0.0}" -f "$REPO_ROOT/deploy/edge-runtime.Dockerfile" "$REPO_ROOT"
echo "Images built: motherbase-deps:1.0.0, ${API_IMAGE:-motherbase-api:1.0.0}, ${EDGE_RUNTIME_IMAGE:-motherbase-edge-runtime:1.0.0}, ${CONSOLE_IMAGE:-motherbase-console:1.0.0}, ${ORCHESTRATION_IMAGE:-motherbase-orchestrator:1.0.0}, motherbase-postgres:1.0.0"
