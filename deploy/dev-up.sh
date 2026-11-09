#!/usr/bin/env bash
# Start the local dev platform: HTTP-only Traefik + Console in dev mode.
# Projects created in the Console route at http://<name>.localhost (no DNS/TLS).
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

echo "==> Starting dev Traefik (:80, dashboard :8080)"
docker network create traefik_proxy 2>/dev/null || true
docker compose -f deploy/traefik/docker-compose.dev.yml up -d

echo "==> Starting Console in dev mode on http://localhost:5500"
echo "    Create a project with no domain -> http://<name>.localhost"
CONSOLE_MODE=dev npm run console:dev
