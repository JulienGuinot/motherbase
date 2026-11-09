#!/usr/bin/env bash
# Critical HTTP flows against an existing, dedicated smoke project.
# No deployment is performed and every created row/file is removed best-effort.
set -euo pipefail

: "${CONSOLE_URL:?CONSOLE_URL is required}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"
: "${PROJECT:?PROJECT is required}"
: "${PROJECT_URL:?PROJECT_URL is required}"
: "${PROJECT_EMAIL:?PROJECT_EMAIL is required}"
: "${PROJECT_PASSWORD:?PROJECT_PASSWORD is required}"
: "${RLS_MODEL:?RLS_MODEL is required (id, user_id and label columns)}"
: "${PRIVATE_EDGE_ROUTE:?PRIVATE_EDGE_ROUTE is required}"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/smoke-http.sh"
CONSOLE_URL="${CONSOLE_URL%/}"
PROJECT_URL="${PROJECT_URL%/}"
jar="$(mktemp)"
body_file="$(mktemp)"
download_file="$(mktemp)"
upload_file="$(mktemp)"
row_id="contract-$(date +%s)-${RANDOM}"
file_id=""
token=""

cleanup() {
  if [ -n "$token" ]; then
    smoke_http -X DELETE -H "Authorization: Bearer $token" \
      "${PROJECT_URL}/rest/v1/${RLS_MODEL}?id=eq.${row_id}" >/dev/null 2>&1 || true
    if [ -n "$file_id" ]; then
      smoke_http -X DELETE -H "Authorization: Bearer $token" \
        "${PROJECT_URL}/api/files/${file_id}" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$jar" "$body_file" "$download_file" "$upload_file"
}
trap cleanup EXIT

status() {
  smoke_http -o "$body_file" -w '%{http_code}' "$@"
}

expect_status() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" != "$expected" ]; then
    printf 'FAIL %s: expected %s, got %s\n' "$name" "$expected" "$actual" >&2
    return 1
  fi
  printf 'PASS %s\n' "$name"
}

json_field() {
  node -e "const fs=require('fs'); const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const out=process.argv[2].split('.').reduce((v,k)=>v?.[k],value); if(out==null) process.exit(2); process.stdout.write(String(out));" "$body_file" "$1"
}

# 1. Console login.
code="$(status -X POST -b "$jar" -c "$jar" -H 'Content-Type: application/json' \
  -d "$(smoke_json email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD")" \
  "${CONSOLE_URL}/api/platform/login")"
expect_status 'Console login' 200 "$code"

# 2. Require the fixture project; an empty project cannot exercise these flows.
code="$(status -b "$jar" "${CONSOLE_URL}/api/platform/projects")"
expect_status 'Console projects list' 200 "$code"
if ! node -e "const fs=require('fs'); const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.exit((b.data||[]).some(p=>(p.name||p.id)===process.argv[2])?0:1)" "$body_file" "$PROJECT"; then
  echo 'Dedicated smoke project missing; provision its user, RLS table and private Edge fixture first' >&2
  exit 1
else
  printf 'PASS Dedicated smoke project exists\n'
fi

# Authenticate once for the three project-level flows.
code="$(status -X POST -H 'Content-Type: application/json' \
  -d "$(smoke_json email "$PROJECT_EMAIL" password "$PROJECT_PASSWORD")" \
  "${PROJECT_URL}/api/auth/sign-in/email")"
expect_status 'Project login prerequisite' 200 "$code"
token="$(json_field token)"
user_id="$(json_field user.id)"

# 3. CRUD through REST with an owner-scoped RLS fixture model.
foreign_payload="$(node -e 'process.stdout.write(JSON.stringify({id:process.argv[1]+"-foreign",user_id:"foreign-user",label:"forbidden"}))' "$row_id")"
code="$(status -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$foreign_payload" \
  "${PROJECT_URL}/rest/v1/${RLS_MODEL}")"
expect_status 'REST RLS rejects foreign owner' 403 "$code"
payload="$(node -e 'process.stdout.write(JSON.stringify({id:process.argv[1],user_id:process.argv[2],label:"created"}))' "$row_id" "$user_id")"
code="$(status -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$payload" \
  "${PROJECT_URL}/rest/v1/${RLS_MODEL}")"
expect_status 'REST RLS create' 201 "$code"
code="$(status -X PATCH -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"label":"updated"}' \
  "${PROJECT_URL}/rest/v1/${RLS_MODEL}?id=eq.${row_id}")"
expect_status 'REST RLS update' 200 "$code"
code="$(status -H "Authorization: Bearer $token" "${PROJECT_URL}/rest/v1/${RLS_MODEL}?id=eq.${row_id}")"
expect_status 'REST RLS read' 200 "$code"
node -e 'const fs=require("fs"), assert=require("assert/strict"), rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); assert.equal(rows.length,1); assert.equal(rows[0].id,process.argv[2]); assert.equal(rows[0].user_id,process.argv[3]); assert.equal(rows[0].label,"updated");' "$body_file" "$row_id" "$user_id"
code="$(status -X DELETE -H "Authorization: Bearer $token" "${PROJECT_URL}/rest/v1/${RLS_MODEL}?id=eq.${row_id}")"
expect_status 'REST RLS delete' 200 "$code"
code="$(status -H "Authorization: Bearer $token" "${PROJECT_URL}/rest/v1/${RLS_MODEL}?id=eq.${row_id}")"
expect_status 'REST RLS read after delete' 200 "$code"
node -e 'const fs=require("fs"), assert=require("assert/strict"); assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[1],"utf8")),[]);' "$body_file"

# 4. Authenticated upload + byte-for-byte download.
printf 'motherbase-contract-upload' > "$upload_file"
code="$(status -X POST -H "Authorization: Bearer $token" -F "file=@${upload_file};filename=contract.txt" \
  "${PROJECT_URL}/api/files/")"
expect_status 'Storage upload' 200 "$code"
file_id="$(json_field data.file.id)"
code="$(smoke_http -o "$download_file" -w '%{http_code}' -H "Authorization: Bearer $token" \
  "${PROJECT_URL}/api/files/${file_id}/raw")"
expect_status 'Storage download' 200 "$code"
cmp "$upload_file" "$download_file"

# 5. A private Edge must reject anonymous calls and accept the bearer.
code="$(status -X POST -H 'Content-Type: application/json' -d '{"smoke":true}' \
  "${PROJECT_URL}/api/edge/${PRIVATE_EDGE_ROUTE}")"
expect_status 'Private Edge rejects anonymous invocation' 401 "$code"
code="$(status -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"smoke":true}' \
  "${PROJECT_URL}/api/edge/${PRIVATE_EDGE_ROUTE}")"
expect_status 'Private Edge invocation' 200 "$code"
