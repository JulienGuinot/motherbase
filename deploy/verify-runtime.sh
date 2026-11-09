#!/usr/bin/env bash
# Local/CI release gate. Only destroys resources belonging to this random run.
set -euo pipefail
case "${1:-}" in
  ''|--config) ;;
  *) echo 'Usage: bash deploy/verify-runtime.sh [--config]' >&2; exit 2 ;;
esac
cd "$(dirname "${BASH_SOURCE[0]}")/.."
verify_dir="$(mktemp -d)"
project="motherbase-verify-$(date +%s)-${RANDOM}"
env_file="$verify_dir/runtime.env"
umask 077
cat > "$env_file" <<EOF
COMPOSE_PROJECT_NAME=$project
API_IMAGE=motherbase-api:1.0.0
POSTGRES_IMAGE=motherbase-postgres:1.0.0
POSTGRES_PASSWORD=verify-postgres-local-only
MINIO_ROOT_USER=verifyminio
MINIO_ROOT_PASSWORD=verify-minio-local-only
MINIO_IMAGE=alpine/minio:RELEASE.2025-10-15T17-29-55Z
MINIO_MC_IMAGE=bitnamilegacy/minio-client:2025.5.21@sha256:00dcc4e58ada0df45bb7d9ee435af98295f96c27c3c68292ce78ec700a87b511
JWT_SECRET=verify-jwt-secret-not-used-outside-this-stack
CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
PLATFORM_SERVICE_TOKEN=verify-platform-token-not-used-outside-this-stack
EDGE_RUNTIME_IMAGE=motherbase-edge-runtime:1.0.0
EDGE_RUNTIME_TOKEN=verify-edge-runtime-token-not-used-outside-this-stack
PROJECT_DOMAIN=verify.invalid
STORAGE_DOMAIN=storage.verify.invalid
API_MEM=1536M
API_CPUS=2
EOF
compose() {
  # Shell variables override --env-file. Keep only Docker's connection/runtime
  # environment so no inherited SMTP, storage or application secret can leak in.
  env -i PATH="$PATH" HOME="$HOME" \
    SYSTEMROOT="${SYSTEMROOT:-}" USERPROFILE="${USERPROFILE:-}" \
    APPDATA="${APPDATA:-}" LOCALAPPDATA="${LOCALAPPDATA:-}" \
    DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}" \
    DOCKER_HOST="${DOCKER_HOST:-}" DOCKER_CONTEXT="${DOCKER_CONTEXT:-}" \
    DOCKER_TLS_VERIFY="${DOCKER_TLS_VERIFY:-}" DOCKER_CERT_PATH="${DOCKER_CERT_PATH:-}" \
    docker compose --env-file "$env_file" -p "$project" -f deploy/docker-compose.verify.yml "$@"
}
if [ "${1:-}" = --config ]; then
  # Validate the fully merged production definitions without a Docker daemon.
  result=0
  compose config --quiet || result=$?
  rm -f -- "$env_file"
  rmdir -- "$verify_dir"
  exit "$result"
fi
cleanup() {
  result=$?
  trap - EXIT
  if [ "$result" != 0 ]; then compose logs --tail 80 >&2 || true; fi
  compose down --volumes --remove-orphans || result=1
  rm -f -- "$env_file"
  rmdir -- "$verify_dir"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose up -d --no-build --wait --wait-timeout 240
# --user node, not the image default: the server runs as `node` since PKG-13 and
# its two volumes are owned by it, while `exec` still lands as root. With
# cap_drop: ALL that root has no DAC_OVERRIDE, so it has *less* access to those
# volumes than the service account does -- the drill's pg_dump failed with
# "could not open output file /app/backups/...: Permission denied" while the
# API itself was backing up fine. Run as the account the server runs as.
compose exec -T --user node api node apps/server/scripts/verify-runtime.cjs
# One real invocation, API -> sidecar -> worker process, under the production
# hardening (read-only root, no capabilities): the part no unit test can see.
compose exec -T --user node api node -e "require('./apps/server/dist/services/admin/edge-sandbox').runInSandbox('(async () => 40 + 2)()', {}).then(r => { if (r.value !== 42) { console.error('edge runtime:', r.error); process.exit(1); } })"
echo 'PASS production API image, edge runtime, storage round trip and database restore drill'
