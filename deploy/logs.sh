#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
Usage: ./deploy/logs.sh [service] [docker compose logs options...]

Follows the logs of the current stack (see ./deploy/status.sh for which one).
Defaults to the `console` service on a VPS and `api` locally.

Every remaining argument is passed straight to `docker compose logs`.

Examples:
  ./deploy/logs.sh                        # follow the default service
  ./deploy/logs.sh orchestrator --tail 100
  ./deploy/logs.sh console --since 10m

This helper targets the platform stack. For a project stack, use the Console,
`motherbase projects logs <name>`, or an explicit production Compose command.
USAGE
  exit 0
fi

if [ "$(stack_mode)" = "vps" ]; then
  service="console"
else
  service="api"
fi

if [ "${1:-}" != "" ] && [ "${1#-}" = "$1" ]; then
  service="$1"
  shift
fi

stack_compose logs -f "$service" "$@"
