#!/usr/bin/env bash
# HTTP smoke test for a running Console (local or VPS). Exercises the routes
# most likely to regress, so they show up without manual clicking:
#   - platform login + info + projects list
#   - a project's settings groups (console.sql / server.cors / auth.tokens)
#   - admin storage/users/extensions routes that catch Console routing regressions
#   - email templates (read-only: never overwrite an installation's templates)
#   - edge-functions through the console proxy
#   - realtime events (the known-good control)
#
# Usage:
#   CONSOLE_URL=https://console.test.example.com \
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<console-password>' \
#   PROJECT=test ./tests/vps-smoke.sh
#
# Use an existing, dedicated smoke project. No project is auto-provisioned.
set -euo pipefail

CONSOLE_URL="${CONSOLE_URL:-http://localhost:5500}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
PROJECT="${PROJECT:?PROJECT must name an existing dedicated smoke project}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required for the Console smoke test}"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-http.sh"
CONSOLE_URL="${CONSOLE_URL%/}"

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

pass=0 fail=0
green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; rst=$'\033[0m'

# req METHOD PATH [json-body] -> echoes "HTTP_STATUS\n<body>"
req() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    smoke_http -X "$method" -b "$JAR" -c "$JAR" \
      -H 'Content-Type: application/json' -d "$body" \
      -w $'\n%{http_code}' "${CONSOLE_URL}${path}"
  else
    smoke_http -X "$method" -b "$JAR" -c "$JAR" \
      -w $'\n%{http_code}' "${CONSOLE_URL}${path}"
  fi
}

# check NAME METHOD PATH EXPECTED_STATUS [json-body]
check() {
  local name="$1" method="$2" path="$3" expected="$4" body="${5:-}"
  local out status
  out="$(req "$method" "$path" "$body")" || return 1
  status="${out##*$'\n'}"
  if [ "$status" = "$expected" ]; then
    printf '  %s✓%s %-46s %s%s%s\n' "$green" "$rst" "$name" "$dim" "$status" "$rst"
    pass=$((pass + 1))
  else
    printf '  %s✗%s %-46s expected %s, got %s%s\n' "$red" "$rst" "$name" "$expected" "$status" "$rst"
    fail=$((fail + 1))
    return 1
  fi
}

echo "▸ Console: $CONSOLE_URL   project: $PROJECT"

# ── 1. Platform auth ────────────────────────────────────────────────────────
echo "── Platform"
check "login"          POST "/api/platform/login"  200 \
  "$(smoke_json email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD")"
check "info"           GET  "/api/platform/info"     200
check "projects list"  GET  "/api/platform/projects" 200

# ── 2. Require the preconfigured smoke project ──────────────────────────────
proj_out="$(req GET "/api/platform/projects")"
if ! printf '%s' "${proj_out%$'\n'*}" | node -e 'const fs=require("fs"), b=JSON.parse(fs.readFileSync(0,"utf8")); process.exit((b.data||[]).some(p=>(p.name||p.id)===process.argv[1])?0:1)' "$PROJECT"; then
  echo 'Dedicated smoke project missing; provision its user, RLS table and private Edge fixture first' >&2
  exit 1
fi

# ── 3. Project settings groups ──────────────────────────────────────────────────
echo "── Project settings (via console proxy)"
check "settings list"          GET "/api/projects/$PROJECT/admin/settings"               200
check "settings console.sql"   GET "/api/projects/$PROJECT/admin/settings/console.sql"   200
check "settings server.cors"   GET "/api/projects/$PROJECT/admin/settings/server.cors"   200
check "settings auth.tokens"   GET "/api/projects/$PROJECT/admin/settings/auth.tokens"   200
check "storage files"          GET "/api/projects/$PROJECT/admin/storage/files"          200
check "admin users"            GET "/api/projects/$PROJECT/admin/users"                  200
check "schema extensions"      GET "/api/projects/$PROJECT/admin/schema/extensions"      200

# ── 4. Read templates without changing configured emails ──────────────────
check "email templates" GET "/api/projects/$PROJECT/admin/settings/email.templates" 200

# ── 5. edge-functions through the console proxy ────────────────────────────────
echo "── Edge functions & realtime"
check "edge-functions (401 fix)" GET "/api/projects/$PROJECT/admin/edge-functions" 200
check "realtime events (control)" GET "/api/projects/$PROJECT/admin/realtime/events" 200

echo
printf 'Result: %s%d passed%s, %s%d failed%s\n' "$green" "$pass" "$rst" \
  "$([ "$fail" -gt 0 ] && echo "$red" || echo "$dim")" "$fail" "$rst"
[ "$fail" -eq 0 ]
