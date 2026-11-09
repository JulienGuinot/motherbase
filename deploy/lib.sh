#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

source "$repo_root/deploy/docker-cleanup.sh"

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

die() {
  echo "Error: $*" >&2
  exit 1
}

# Same guard as setup.sh, but it has to fire before anything else runs:
# update.sh does its `git pull` before it ever reaches setup.sh, so `sudo
# ./deploy/update.sh` used to leave a root-owned .git/ORIG_HEAD behind and the
# next CI deploy refused the checkout. These scripts elevate through $SUDO.
owner="$(stat -c '%U' . 2>/dev/null || true)"
if [ "$(id -u)" = "0" ] && [ -e .git ] && [ -n "$owner" ] && [ "$owner" != root ] && [ "$owner" != UNKNOWN ]; then
  die "Do not run this as root inside ${owner}'s checkout: it leaves root-owned files in .git and the next deploy refuses them. Re-run as ${owner}:  su - ${owner} -c 'cd $PWD && $0 $*'"
fi

info() {
  echo "==> $*"
}

get_env() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | head -1 | cut -d= -f2-
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    die "Docker Compose is not installed"
  fi
}

stack_mode() {
  local base_host
  base_host="$(get_env BASE_HOST || true)"

  if [ -z "$base_host" ] || echo "$base_host" | grep -qE '^localhost(:[0-9]+)?$'; then
    echo "local"
  else
    echo "vps"
  fi
}

stack_compose() {
  if [ "$(stack_mode)" = "vps" ]; then
    compose -f deploy/console/docker-compose.yml --env-file deploy/console/.env "$@"
  else
    compose "$@"
  fi
}

platform_projects_dir() {
  if [ -n "${PROJECTS_DIR:-}" ]; then
    echo "$PROJECTS_DIR"
  else
    echo "/srv/projects"
  fi
}

platform_project_compose_file() {
  if [ -n "${COMPOSE_FILE:-}" ]; then
    echo "$COMPOSE_FILE"
  else
    echo "$repo_root/deploy/docker-compose.prod.yml"
  fi
}

for_each_platform_project() {
  local callback="$1"
  local projects_dir env_file project_dir project

  projects_dir="$(platform_projects_dir)"
  [ -d "$projects_dir" ] || return 0

  for env_file in "$projects_dir"/*/.env.prod; do
    [ -f "$env_file" ] || continue
    project_dir="$(dirname "$env_file")"
    project="$(basename "$project_dir")"
    "$callback" "$project" "$project_dir" "$env_file"
  done
}

stop_platform_project() {
  local project="$1" _project_dir="$2" env_file="$3"
  local compose_file

  compose_file="$(platform_project_compose_file)"
  info "Stopping project stack: $project"
  compose -f "$compose_file" --env-file "$env_file" -p "$project" down --remove-orphans \
    || remove_containers_by_project "$project"
}

reset_platform_project() {
  local project="$1" project_dir="$2" env_file="$3"
  local compose_file

  compose_file="$(platform_project_compose_file)"
  info "Resetting project stack: $project"
  compose -f "$compose_file" --env-file "$env_file" -p "$project" down -v --remove-orphans \
    || remove_compose_project_data "$project"
  $SUDO rm -rf -- "$project_dir"
}

stop_platform_projects_if_needed() {
  [ "$(stack_mode)" = "vps" ] || return 0
  for_each_platform_project stop_platform_project
}

reset_platform_projects_if_needed() {
  [ "$(stack_mode)" = "vps" ] || return 0
  for_each_platform_project reset_platform_project
}

start_proxy_if_needed() {
  if [ "$(stack_mode)" != "vps" ]; then
    return
  fi

  docker network inspect traefik_proxy >/dev/null 2>&1 || docker network create traefik_proxy >/dev/null
  if [ -f deploy/traefik/.env ]; then
    compose -f deploy/traefik/docker-compose.yml --env-file deploy/traefik/.env up -d
  else
    compose -f deploy/traefik/docker-compose.yml up -d
  fi
}

seed_admin() {
  if [ "$(stack_mode)" = "vps" ]; then
    info "Skipping seed, not applicable in console mode (projects are seeded on creation)"
    return
  fi
  local attempt
  for attempt in $(seq 1 30); do
    if stack_compose exec -T --user node api node apps/server/dist/prisma/seed.js; then
      return
    fi
    sleep 2
  done

  die "Admin seed failed after waiting for the API container"
}

confirm_destructive() {
  local assume_yes="${1:-0}"
  local message="${2:-This will delete Docker volumes and local data. Continue?}"

  [ "$assume_yes" = "1" ] && return

  printf '%s [y/N]: ' "$message"
  local answer
  read -r answer
  case "$answer" in
    [Yy]*) ;;
    *) die "Aborted" ;;
  esac
}
