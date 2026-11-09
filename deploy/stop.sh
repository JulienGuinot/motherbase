#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

with_proxy=0

for arg in "$@"; do
  case "$arg" in
    --with-proxy) with_proxy=1 ;;
    -h|--help)
      echo "Usage: ./deploy/stop.sh [--with-proxy]"
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

info "Stopping $(stack_mode) stack"
stop_platform_projects_if_needed
stack_compose down --remove-orphans

if [ "$with_proxy" = "1" ] && [ "$(stack_mode)" = "vps" ]; then
  info "Stopping Traefik"
  if [ -f deploy/traefik/.env ]; then
    compose -f deploy/traefik/docker-compose.yml --env-file deploy/traefik/.env down --remove-orphans
  else
    compose -f deploy/traefik/docker-compose.yml down --remove-orphans
  fi
fi

info "Stack stopped"
