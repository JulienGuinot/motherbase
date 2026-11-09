#!/usr/bin/env bash
# End-to-end VPS test: SSH into the server, pull the latest code, redeploy the
# Console (rebuilds the api + console images and restarts the console), then run
# the HTTP smoke test (tests/vps-smoke.sh) against the public Console URL.
#
# Credentials are read from the environment. Nothing is baked into the repo. Provide a password (via sshpass) or rely on your SSH key/agent.
#
# Usage:
#   VPS_HOST=203.0.113.10 \
#   VPS_PASSWORD='********' \
#   CONSOLE_URL=https://console.test.example.com \
#   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='<console-password>' \
#   PROJECT=test \
#   ./tests/vps-e2e.sh
#
# Optional:
#   VPS_USER       (default: motherbase; root is refused)
#   REMOTE_DIR     (default: boilerplate-backend)   repo dir on the VPS, under $HOME
#   GIT_REMOTE/GIT_BRANCH (default: origin/master)
#   SKIP_DEPLOY=1  run only the smoke test (no SSH/redeploy)



set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VPS_HOST="${VPS_HOST:-}"
VPS_USER="${VPS_USER:-motherbase}"
VPS_PASSWORD="${VPS_PASSWORD:-}"
REMOTE_DIR="${REMOTE_DIR:-boilerplate-backend}"
GIT_REMOTE="${GIT_REMOTE:-origin}"
GIT_BRANCH="${GIT_BRANCH:-master}"
CONSOLE_URL="${CONSOLE_URL:-}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"

die() { echo "Error: $*" >&2; exit 1; }
[ "$VPS_USER" != "root" ] || die "VPS_USER=root is refused; use an unprivileged deploy account"

# ssh/scp wrappers that use sshpass when a password is supplied, otherwise the
# user's SSH key/agent. StrictHostKeyChecking is disabled for first-contact CI use.
SSH_BASE=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
run_ssh() {
  if [ -n "$VPS_PASSWORD" ]; then
    command -v sshpass >/dev/null 2>&1 || die "sshpass not installed (apt-get install sshpass), or use an SSH key and unset VPS_PASSWORD"
    sshpass -p "$VPS_PASSWORD" ssh "${SSH_BASE[@]}" "${VPS_USER}@${VPS_HOST}" "$@"
  else
    ssh "${SSH_BASE[@]}" "${VPS_USER}@${VPS_HOST}" "$@"
  fi
}

if [ "$SKIP_DEPLOY" != "1" ]; then
  [ -n "$VPS_HOST" ] || die "VPS_HOST is required (or set SKIP_DEPLOY=1 to only run the smoke test)"

  echo "▸ [1/3] Pull latest code on ${VPS_USER}@${VPS_HOST}:~/${REMOTE_DIR}"
  run_ssh "set -e; cd ~/${REMOTE_DIR}; git fetch ${GIT_REMOTE} ${GIT_BRANCH}; git switch ${GIT_BRANCH}; git pull --ff-only ${GIT_REMOTE} ${GIT_BRANCH}; git --no-pager log -1 --oneline"

  echo "▸ [2/3] Redeploy Console (rebuild images + restart, non-interactive)"
  # ./setup.sh --yes keeps the existing .env, rebuilds motherbase-api/console and
  # restarts the console container with --force-recreate, which deploys new code.
  run_ssh "set -e; cd ~/${REMOTE_DIR}; ./setup.sh --yes --skip-dns-check"
else
  echo "▸ SKIP_DEPLOY=1: running the smoke test only"
fi

echo "▸ [3/3] Smoke test the HTTP API"
[ -n "$CONSOLE_URL" ] || die "CONSOLE_URL is required for the smoke test"
CONSOLE_URL="$CONSOLE_URL" \
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}" \
ADMIN_PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD is required for the VPS smoke test}" \
PROJECT="${PROJECT:-test}" \
  bash "${here}/vps-smoke.sh"
