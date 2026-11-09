#!/usr/bin/env bash
# Full reset: return the repo to a fresh post-`git clone` state.
#
# Removes every artifact this install created: all containers, volumes and
# networks (stack, Console, Traefik and every provisioned project), the built
# Docker images, the generated .env files, and the provisioned-project data.
# It does NOT start anything back up: run ./setup.sh afterwards to reinstall.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

assume_yes=0
keep_images=0

for arg in "$@"; do
  case "$arg" in
    -y|--yes) assume_yes=1 ;;
    --keep-images) keep_images=1 ;;
    -h|--help)
      echo "Usage: ./deploy/reset.sh [--yes] [--keep-images]"
      echo "Returns the repo to a fresh post-clone state: removes all containers,"
      echo "volumes, networks, built images, .env files and provisioned projects."
      echo "Does not restart anything."
      echo
      echo "  --yes           skip the confirmation prompt"
      echo "  --keep-images   keep the built motherbase-* Docker images"
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

confirm_destructive "$assume_yes" \
  "This DESTROYS all containers, volumes, networks, built images, .env files and provisioned projects for this install (back to a fresh checkout). Continue?"

# 1. Provisioned project stacks. On VPS these are dirs under /srv/projects with a
#    per-project compose file; tear each down (-v) and delete its directory.
info "Removing provisioned project stacks"
reset_platform_projects_if_needed

# 2. Console + Traefik. Both the prod (TLS) and dev (HTTP) compose files. Pass the
#    env file when present so Compose interpolation succeeds; fall back to a
#    label-based teardown so a missing/partial .env never blocks the reset.
info "Removing Console and Traefik"
console_down() {
  local f="$1"
  [ -f "$f" ] || return 0
  if [ -f deploy/console/.env ]; then
    compose -f "$f" --env-file deploy/console/.env down -v --remove-orphans 2>/dev/null || true
  fi
}
traefik_down() {
  local f="$1"
  [ -f "$f" ] || return 0
  if [ -f deploy/traefik/.env ]; then
    compose -f "$f" --env-file deploy/traefik/.env down -v --remove-orphans 2>/dev/null || true
  else
    compose -f "$f" down -v --remove-orphans 2>/dev/null || true
  fi
}
console_down deploy/console/docker-compose.yml
console_down deploy/console/docker-compose.dev.yml
traefik_down deploy/traefik/docker-compose.yml
traefik_down deploy/traefik/docker-compose.dev.yml
# Label-based fallback (covers a missing console .env or a renamed compose project).
remove_compose_project_data console || true
remove_compose_project_data traefik || true

# 3. Legacy single stack (older local installs) + any leftover project data,
#    matched by the db/minio volume naming the project compose files use.
info "Removing legacy stack and leftover project data"
stack_compose down -v --remove-orphans 2>/dev/null || true
compose down -v --remove-orphans 2>/dev/null || true
for stale_vol in $(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '(_db_data|_minio_data|_console_projects)$' || true); do
  remove_volume_stack_data "$stale_vol" 2>/dev/null || docker volume rm -f "$stale_vol" 2>/dev/null || true
done

# 4. Built images. Every provisioned project runs motherbase-api:1.0.0, and the
#    Console runs motherbase-console:1.0.0.
if [ "$keep_images" != "1" ]; then
  info "Removing built Docker images"
  docker image rm -f motherbase-api:1.0.0 motherbase-console:1.0.0 2>/dev/null || true
fi

# 5. The shared Traefik network (only removable once every attached container is gone).
docker network rm traefik_proxy 2>/dev/null || true

# 6. Generated files. Back to a fresh checkout.
info "Removing generated env files and provisioned-project data"
$SUDO rm -f .env deploy/console/.env deploy/traefik/.env
$SUDO rm -rf .dev-projects
if [ -d /srv/projects ]; then
  $SUDO rm -rf -- /srv/projects/* 2>/dev/null || true
fi

info "Reset complete: the repo is back to a fresh post-clone state."
echo "    Reinstall with: ./setup.sh"
