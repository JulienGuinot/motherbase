#!/usr/bin/env bash
#
# Interactive setup wizard: brings the backend up on any machine or VPS.
#
# Usage:
#   ./setup.sh                   # interactive (asks all questions)
#   ./setup.sh --yes             # non-interactive, accept all defaults (local mode)
#   ./setup.sh --reset           # destroy containers/volumes, then rebuild/restart from zero
#   DOMAIN=x.com \
#     ACME_EMAIL=y@z.com \
#     ./setup.sh --yes           # non-interactive VPS mode
#   ./setup.sh --skip-dns-check  # skip DNS propagation prompt in VPS mode
#   ./setup.sh --build           # compile every image locally instead of pulling
#                                # the ones CI published for this commit
#   ./setup.sh --allow-root      # allow running as root inside a checkout owned
#                                # by another user (it leaves root-owned files in
#                                # their working tree; normally refused)
#
# What it does:
#   1. Ensures Docker + Compose are installed (auto-installs on Linux).
#   2. Asks: local dev or VPS/production?
#   3. Collects config (base domain, admin credentials, optional services).
#   4. Generates .env with strong unique secrets (only if missing).
#   5. (VPS) Shows the single wildcard DNS record required for Console + projects.
#   6. Pulls the images CI published for this commit, or builds them locally.
#   7. Builds + starts the Console, which creates isolated project stacks.
#   8. Prints the Console URL, DNS status, and management commands.
#
# Must be executed, not sourced.

echo "
░███     ░███               ░██    ░██                            ░██                                         
░████   ░████               ░██    ░██                            ░██                                         
░██░██ ░██░██  ░███████  ░████████ ░████████   ░███████  ░██░████ ░████████   ░██████    ░███████   ░███████  
░██ ░████ ░██ ░██    ░██    ░██    ░██    ░██ ░██    ░██ ░███     ░██    ░██       ░██  ░██        ░██    ░██ 
░██  ░██  ░██ ░██    ░██    ░██    ░██    ░██ ░█████████ ░██      ░██    ░██  ░███████   ░███████  ░█████████ 
░██       ░██ ░██    ░██    ░██    ░██    ░██ ░██        ░██      ░███   ░██ ░██   ░██         ░██ ░██        
░██       ░██  ░███████      ░████ ░██    ░██  ░███████  ░██      ░██░█████   ░█████░██  ░███████   ░███████  
                                                                                                              
                                                                                                              
                                                                                                              "

if [ "${BASH_SOURCE[0]:-$0}" != "${0}" ]; then
  echo "Run it, don't source it:  ./setup.sh" >&2
  return 1 2>/dev/null || exit 1
fi

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

# ── Output helpers ─────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
  YLW=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; RST=""
fi
step()    { printf '\n%s▸ %s%s\n' "$BOLD$CYN" "$1" "$RST"; }
ok()      { printf '%s✓%s %s\n' "$GRN" "$RST" "$1"; }
warn()    { printf '%s!%s %s\n' "$YLW" "$RST" "$1"; }
die()     { printf '%s✗ %s%s\n' "$RED" "$1" "$RST" >&2; exit 1; }
section() { printf '\n%s── %s ──%s\n' "$BOLD" "$1" "$RST"; }

source deploy/docker-cleanup.sh

# ── Arg parsing ────────────────────────────────────────────────────────────────
ASSUME_YES=0
SKIP_DNS_CHECK=0
ALLOW_ROOT=0
FRESH_RESET=0
FRESH_RESET_CONFIRMED=0
FORCE_BUILD=0
MODE_DEFAULT="L"
for a in "$@"; do
  case "$a" in
    --yes|-y)           ASSUME_YES=1 ;;
    --prod)             MODE_DEFAULT="v" ;;   # backwards compat
    --reset|--fresh)    FRESH_RESET=1 ;;
    --skip-dns-check)   SKIP_DNS_CHECK=1 ;;
    --allow-root)       ALLOW_ROOT=1 ;;
    --build)            FORCE_BUILD=1 ;;
    --help|-h)          grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done
# DOMAIN env var implies VPS mode
[ -n "${DOMAIN:-}" ] && MODE_DEFAULT="v"

# ── Do not poison someone else's checkout ─────────────────────────────────────
# This script escalates on its own, through $SUDO, for the few things that need
# root. Run as root it does the opposite: $SUDO is empty, and every file it
# creates in the working tree ends up owned by root, including the objects git
# writes. The deploy user's next `git fetch` then dies with "insufficient
# permission for adding an object to repository database .git/objects" and the
# deployment stops, 11 seconds in, with no clue why.
#
# So: refuse, but only in the case that actually causes it, which is root
# running inside a checkout that belongs to someone else. A box where
# everything genuinely is root's own is unaffected, and --allow-root is there
# for anyone who means it.
assert_not_root_in_foreign_checkout() {
  # `set -e` is already on, so every test here is an `if`: a bare `[ … ] &&
  # return 0` whose test is false makes the whole list fail and kills the script.
  if [ "$(id -u)" != "0" ]; then return 0; fi
  if [ "$ALLOW_ROOT" = "1" ]; then return 0; fi
  if [ ! -e .git ]; then return 0; fi

  local owner=""
  owner="$(stat -c '%U' . 2>/dev/null || true)"
  case "$owner" in
    ''|root|UNKNOWN) return 0 ;;
  esac

  die "Running as root inside ${owner}'s checkout leaves root-owned files behind in it, .git included, and that user's next 'git fetch' then dies with \"insufficient permission for adding an object to repository database .git/objects\" and takes the deployment with it. This script elevates on its own where it needs root, so re-run it as ${owner}:  su - ${owner} -c 'cd $PWD && ./setup.sh $*'   If you really mean to run as root in this directory, pass --allow-root."
}
assert_not_root_in_foreign_checkout "$@"

# Global state (set by collect_* functions)
MODE=""
MOTHERBASE_IMAGE_TAG="${MOTHERBASE_IMAGE_TAG:-1.0.0}"
DEPS_IMAGE="motherbase-deps:${MOTHERBASE_IMAGE_TAG}"
API_IMAGE="${API_IMAGE:-motherbase-api:${MOTHERBASE_IMAGE_TAG}}"
CONSOLE_IMAGE="${CONSOLE_IMAGE:-motherbase-console:${MOTHERBASE_IMAGE_TAG}}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-motherbase-postgres:${MOTHERBASE_IMAGE_TAG}}"
ORCHESTRATION_IMAGE="${ORCHESTRATION_IMAGE:-motherbase-orchestrator:${MOTHERBASE_IMAGE_TAG}}"
# Fixed, not tagged or overridable: it must be the name the compose files
# default to, because nothing passes EDGE_RUNTIME_IMAGE through to the Console.
EDGE_RUNTIME_IMAGE="motherbase-edge-runtime:1.0.0"
# Where CI publishes the images (.github/workflows/ci.yml, "Publish images").
MOTHERBASE_REGISTRY="${MOTHERBASE_REGISTRY:-ghcr.io/julienguinot}"
MINIO_IMAGE="${MINIO_IMAGE:-alpine/minio:RELEASE.2025-10-15T17-29-55Z}"
MINIO_MC_IMAGE="${MINIO_MC_IMAGE:-bitnamilegacy/minio-client:2025.5.21}"
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.3}"
TRAEFIK_DOCKER_PROXY_IMAGE="${TRAEFIK_DOCKER_PROXY_IMAGE:-nginx:alpine}"
DOCKER_CLI_IMAGE="${DOCKER_CLI_IMAGE:-docker:27-cli}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}" ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" ADMIN_PASSWORD_GENERATED=0
API_PORT="5001" MINIO_PORT="59000" MINIO_CONSOLE_PORT="59001"
DOMAIN="${DOMAIN:-}" STORAGE_DOMAIN="" CONSOLE_DOMAIN="${CONSOLE_DOMAIN:-}" ACME_EMAIL="${ACME_EMAIL:-}"
SMTP_HOST="" SMTP_PORT="587" SMTP_USER="" SMTP_PASS="" SMTP_FROM=""
DNS_CHALLENGE_PROVIDER="" GODADDY_API_KEY="" GODADDY_API_SECRET="" CERT_RESOLVER="letsencrypt"
FB_PROJECT_ID="" FB_CLIENT_EMAIL="" FB_PRIVATE_KEY=""
APNS_KEY="" APNS_KEY_ID="" APNS_TEAM_ID="" APNS_BUNDLE_ID="" APNS_PRODUCTION="true"

# ── Prompt helpers ─────────────────────────────────────────────────────────────
# ask "Prompt" "default" varname
ask() {
  local prompt="$1" default="$2" var="$3"
  if [ "$ASSUME_YES" = "1" ]; then printf -v "$var" '%s' "$default"; return; fi
  printf '  %s [%s]: ' "$prompt" "$default"
  local input; read -r input
  printf -v "$var" '%s' "${input:-$default}"
}

# ask_required "Prompt" "preset (env var fallback)" varname
ask_required() {
  local prompt="$1" preset="${2:-}" var="$3"
  if [ "$ASSUME_YES" = "1" ]; then
    [ -n "$preset" ] || die "$prompt is required. Set it as an env var before running with --yes."
    printf -v "$var" '%s' "$preset"; return
  fi
  local input
  while true; do
    if [ -n "$preset" ]; then
      printf '  %s [%s]: ' "$prompt" "$preset"
    else
      printf '  %s: ' "$prompt"
    fi
    read -r input; input="${input:-$preset}"
    [ -n "$input" ] && break
    warn "Required: cannot be empty."
  done
  printf -v "$var" '%s' "$input"
}

# ask_secret "Prompt" varname  (no echo)
ask_secret() {
  local prompt="$1" var="$2"
  if [ "$ASSUME_YES" = "1" ]; then printf -v "$var" '%s' ""; return; fi
  local input
  printf '  %s: ' "$prompt"
  read -rs input; echo
  printf -v "$var" '%s' "$input"
}

# ask_yn "Prompt" y|n varname
ask_yn() {
  local prompt="$1" default="$2" var="$3"
  if [ "$ASSUME_YES" = "1" ]; then printf -v "$var" '%s' "$default"; return; fi
  local display input
  [ "$default" = "y" ] && display="Y/n" || display="y/N"
  printf '  %s [%s]: ' "$prompt" "$display"
  read -r input; input="${input:-$default}"
  case "$input" in [Yy]*) printf -v "$var" '%s' "y" ;; *) printf -v "$var" '%s' "n" ;; esac
}

# ask_choice "Prompt" "A|B|C" default varname
ask_choice() {
  local prompt="$1" choices="$2" default="$3" var="$4"
  if [ "$ASSUME_YES" = "1" ]; then printf -v "$var" '%s' "$default"; return; fi
  local input
  while true; do
    printf '  %s (%s) [%s]: ' "$prompt" "$choices" "$default"
    read -r input; input="${input:-$default}"
    case "|${choices}|" in *"|${input}|"*) break ;; esac
    warn "Choose one of: $choices"
  done
  printf -v "$var" '%s' "$input"
}

# ── Secret generators ──────────────────────────────────────────────────────────
gen_hex()   { openssl rand -hex 32 2>/dev/null   || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
gen_hex24() { openssl rand -hex 24 2>/dev/null   || head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
gen_b64()   { openssl rand -base64 32 2>/dev/null || head -c32 /dev/urandom | base64 | tr -d '\n'; }

is_known_weak_admin_password() {
  local password
  password="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$password" in
    admin|admin123|admin12345|administrator|changeme|letmein|motherbase|password|password1|qwerty123)
      return 0 ;;
    *) return 1 ;;
  esac
}

collect_admin_password() {
  local label="$1" min_length=12
  if [ -z "${ADMIN_PASSWORD:-}" ] && [ "$ASSUME_YES" != "1" ]; then
    ask_secret "$label (leave blank to generate)" ADMIN_PASSWORD
  fi
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="Mb-$(gen_hex24)"
    ADMIN_PASSWORD_GENERATED=1
  fi

  [ "$MODE" = "vps" ] && min_length=16
  [ "${#ADMIN_PASSWORD}" -ge "$min_length" ] \
    || die "$label must be at least ${min_length} characters."
  ! is_known_weak_admin_password "$ADMIN_PASSWORD" \
    || die "$label contains a known weak password pattern. Choose a unique password."

  local classes=0
  case "$ADMIN_PASSWORD" in *[a-z]*) classes=$((classes + 1)) ;; esac
  case "$ADMIN_PASSWORD" in *[A-Z]*) classes=$((classes + 1)) ;; esac
  case "$ADMIN_PASSWORD" in *[0-9]*) classes=$((classes + 1)) ;; esac
  case "$ADMIN_PASSWORD" in *[!a-zA-Z0-9]*) classes=$((classes + 1)) ;; esac
  [ "$classes" -ge 2 ] || die "$label must use at least two character classes."

  local normalized_email normalized_password
  normalized_email="$(printf '%s' "${ADMIN_EMAIL:-}" | tr '[:upper:]' '[:lower:]')"
  normalized_password="$(printf '%s' "$ADMIN_PASSWORD" | tr '[:upper:]' '[:lower:]')"
  [ -z "$normalized_email" ] || [ "$normalized_password" != "$normalized_email" ] \
    || die "$label must not match the admin email."

  if [ "$ADMIN_PASSWORD_GENERATED" = "1" ]; then
    printf '  %sGenerated admin password (shown once):%s %s\n' "$BOLD" "$RST" "$ADMIN_PASSWORD"
  fi
}
get_env_file() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$file" 2>/dev/null || true
}
get_env()      { get_env_file .env "$1"; }
set_env_file() {
  local file="$1" key="$2" value="$3"
  [ -n "$value" ] || return 0
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# ── Docker check ───────────────────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

check_docker() {
  step "Checking Docker"

  _install_docker_linux() {
    warn "Docker not found: installing via get.docker.com"
    curl -fsSL https://get.docker.com | $SUDO sh \
      || die "Docker install failed. Install manually: https://docs.docker.com/engine/install/"
    [ -n "${SUDO}" ] && [ -n "${USER:-}" ] && $SUDO usermod -aG docker "$USER" || true
    $SUDO systemctl enable --now docker 2>/dev/null \
      || $SUDO service docker start 2>/dev/null || true
  }

  if ! command -v docker >/dev/null 2>&1; then
    case "$(uname -s)" in
      Linux)  _install_docker_linux ;;
      Darwin) die "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop, then re-run." ;;
      *)      die "Docker not found. Install Docker (https://docs.docker.com/engine/install/), then re-run." ;;
    esac
  fi
  command -v docker >/dev/null 2>&1 \
    || die "Docker still not on PATH. Open a new shell and re-run ./setup.sh"

  if ! docker info >/dev/null 2>&1; then
    $SUDO systemctl start docker 2>/dev/null || $SUDO service docker start 2>/dev/null || true
    docker info >/dev/null 2>&1 \
      || die "Docker daemon not running. Start Docker / re-login for the docker group, then re-run."
  fi
  ok "Docker $(docker --version | sed 's/,.*//')"

  if docker compose version >/dev/null 2>&1; then
    compose() { docker compose "$@"; }
  elif command -v docker-compose >/dev/null 2>&1; then
    compose() { docker-compose "$@"; }
  else
    die "Docker Compose not found. Install: https://docs.docker.com/compose/install/"
  fi
  ok "Compose ready"
}

console_compose() {
  local file
  if [ "$MODE" = "vps" ]; then
    file="deploy/console/docker-compose.yml"
  else
    file="deploy/console/docker-compose.dev.yml"
  fi
  compose -f "$file" --env-file deploy/console/.env "$@"
}

project_compose() {
  local project="$1" env_file="$2" compose_command
  shift 2
  if docker compose version >/dev/null 2>&1; then
    compose_command=(docker compose)
  else
    compose_command=(docker-compose)
  fi

  # Project env files contain secrets and are root-readable only in production.
  $SUDO env \
    API_IMAGE="$API_IMAGE" \
    POSTGRES_IMAGE="$POSTGRES_IMAGE" \
    MINIO_IMAGE="$MINIO_IMAGE" \
    MINIO_MC_IMAGE="$MINIO_MC_IMAGE" \
    "${compose_command[@]}" -f deploy/docker-compose.prod.yml --env-file "$env_file" -p "$project" "$@"
}

port_listener() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" { print; exit }'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 { print; exit }'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" { print; exit }'
  fi
}

ensure_public_ports_available() {
  # Existing Traefik may already own the ports; Compose can update that container.
  if docker ps --format '{{.Names}}' | grep -qx 'traefik'; then
    return
  fi

  local busy=0 listener port freed svc
  for port in 80 443; do
    listener="$(port_listener "$port" || true)"
    if [ -n "$listener" ]; then
      freed=0
      for svc in nginx apache2 httpd caddy haproxy lighttpd; do
        if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$svc" 2>/dev/null; then
          warn "Stopping $svc (occupying port $port)..."
          $SUDO systemctl stop "$svc" >/dev/null 2>&1 \
            && $SUDO systemctl disable "$svc" >/dev/null 2>&1 \
            && ok "Stopped and disabled $svc" && freed=1 && break
        fi
      done
      if [ "$freed" = "0" ]; then
        warn "Port ${port} is in use: ${listener}"
        busy=1
      fi
    fi
  done

  if [ "$busy" = "1" ]; then
    die "Free ports 80/443 before starting Traefik. If this is nginx: sudo systemctl stop nginx && sudo systemctl disable nginx"
  fi
}

# ── Firewall ───────────────────────────────────────────────────────────────────
open_firewall_ports() {
  local changed=0
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    $SUDO ufw allow 80/tcp  >/dev/null 2>&1 || true; changed=1
    $SUDO ufw allow 443/tcp >/dev/null 2>&1 || true
    ok "ufw: ensured ports 80 and 443 open"
    return
  fi
  if command -v iptables >/dev/null 2>&1; then
    $SUDO iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null \
      || { $SUDO iptables -I INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || true; changed=1; }
    $SUDO iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null \
      || { $SUDO iptables -I INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || true; changed=1; }
    [ "$changed" = "1" ] && ok "iptables: opened ports 80 and 443" || true
  fi
}

# ── DNS polling ────────────────────────────────────────────────────────────────
_resolve_ip() {
  local domain="$1"
  if command -v dig >/dev/null 2>&1; then
    dig +short "$domain" 2>/dev/null | grep -E '^[0-9]+\.' | head -1
  elif command -v nslookup >/dev/null 2>&1; then
    nslookup "$domain" 2>/dev/null | awk '/^Address: [0-9]/ { print $2; exit }'
  elif command -v host >/dev/null 2>&1; then
    host "$domain" 2>/dev/null | awk '/has address/ { print $NF; exit }'
  else
    getent hosts "$domain" 2>/dev/null | awk '{ print $1; exit }'
  fi
}

is_subdomain_of() {
  local host="$1" base="$2"
  case "$host" in
    *."$base") return 0 ;;
    *) return 1 ;;
  esac
}

wait_for_dns() {
  [ "$SKIP_DNS_CHECK" = "1" ] && return 0
  local domain="$1" expected_ip="$2"
  local resolved i
  printf '  Waiting for %s → %s' "$domain" "$expected_ip"
  for i in $(seq 1 36); do
    resolved="$(_resolve_ip "$domain" || true)"
    if [ "$resolved" = "$expected_ip" ]; then
      printf '\n'; ok "DNS OK: $domain → $resolved"; return 0
    fi
    printf '.'
    sleep 10
  done
  printf '\n'
  warn "DNS not propagated for $domain after 6 min, Traefik will retry cert issuance automatically."
}

# ── .env guard ─────────────────────────────────────────────────────────────────
ENV_EXISTS=0
check_env() {
  [ -f .env ] || return 0
  ENV_EXISTS=1
  if [ "$ASSUME_YES" = "1" ]; then
    ok ".env already exists: keeping it and redeploying the stack"; return
  fi
  printf '\n%s.env already exists.%s What do you want to do?\n' "$BOLD" "$RST"
  printf '  [k] Keep it and recreate the stack  (default)\n'
  printf '  [f] Fresh reset Docker data, then restart from zero\n'
  printf '  [r] Regenerate (run the wizard again)\n'
  printf '  [q] Quit\n'
  local choice
  printf '  Choice [k]: '; read -r choice; choice="${choice:-k}"
  case "$choice" in
    [Ff]) FRESH_RESET=1; FRESH_RESET_CONFIRMED=1; ok "Will reset Docker data before starting" ;;
    [Rr]) ENV_EXISTS=0 ;;
    [Qq]) exit 0 ;;
    *)    ok "Keeping existing .env: will recreate the stack" ;;
  esac
}

# ── Optional services ──────────────────────────────────────────────────────────
collect_services() {
  local domain="${1:-}"
  local yn

  ask_yn "Configure SMTP (transactional email)?" "n" yn
  if [ "$yn" = "y" ]; then
    section "SMTP"
    ask        "Host"           ""                               SMTP_HOST
    ask        "Port"           "587"                            SMTP_PORT
    ask        "Username"       ""                               SMTP_USER
    ask_secret "Password"                                        SMTP_PASS
    ask        "From address"   "noreply@${domain:-example.com}" SMTP_FROM
  fi

  ask_yn "Configure Firebase push notifications?" "n" yn
  if [ "$yn" = "y" ]; then
    section "Firebase"
    ask "Project ID"       "" FB_PROJECT_ID
    ask "Client email"     "" FB_CLIENT_EMAIL
    local fb_file
    ask "Service account JSON file path (for private key)" "" fb_file
    if [ -n "$fb_file" ] && [ -f "$fb_file" ]; then
      if command -v python3 >/dev/null 2>&1; then
        FB_PRIVATE_KEY="$(python3 -c \
          "import json; d=json.load(open('$fb_file')); print(d.get('private_key',''))" \
          2>/dev/null || cat "$fb_file")"
      else
        FB_PRIVATE_KEY="$(cat "$fb_file")"
      fi
      ok "Firebase private key loaded"
    else
      [ -z "$fb_file" ] || warn "File not found: set FIREBASE_PRIVATE_KEY in .env manually."
    fi
  fi

  ask_yn "Configure APNS (Apple push notifications)?" "n" yn
  if [ "$yn" = "y" ]; then
    section "APNS"
    local apns_file
    ask ".p8 key file path" "" apns_file
    if [ -n "$apns_file" ] && [ -f "$apns_file" ]; then
      APNS_KEY="$(cat "$apns_file")"
      ok "APNS key loaded"
    else
      [ -z "$apns_file" ] || warn "File not found: set APNS_KEY in .env manually."
    fi
    ask    "Key ID"     "" APNS_KEY_ID
    ask    "Team ID"    "" APNS_TEAM_ID
    ask    "Bundle ID"  "" APNS_BUNDLE_ID
    local apns_env
    ask_yn "Production environment (not sandbox)?" "y" apns_env
    [ "$apns_env" = "y" ] && APNS_PRODUCTION="true" || APNS_PRODUCTION="false"
  fi
}

# ── Collect: local mode ─────────────────────────────────────────────────────────
collect_local() {
  section "Local development"
  ask "Admin email" "${ADMIN_EMAIL:-admin@example.com}" ADMIN_EMAIL
  collect_admin_password "Admin password"
  ask "API port"       "5001"              API_PORT
  ask "MinIO port"     "59000"             MINIO_PORT
  MINIO_CONSOLE_PORT=$((MINIO_PORT + 1))
  collect_services ""
}

# ── Collect: VPS mode ───────────────────────────────────────────────────────────
collect_vps() {
  section "VPS / Console"
  # Console-only install: we provision the Console + Traefik. Per-project
  # settings (domain, storage, SMTP, push, admin) are entered later in the
  # Console's "New project" wizard and each project's Studio, not here.
  ask_required "Base domain for projects (e.g. example.com)"  "$DOMAIN"   DOMAIN
  ask          "Console domain"        "${CONSOLE_DOMAIN:-console.${DOMAIN}}" CONSOLE_DOMAIN
  ask_required "Let's Encrypt email"   "$ACME_EMAIL"                      ACME_EMAIL
  ask          "Console admin email" "${ADMIN_EMAIL:-admin@example.com}" ADMIN_EMAIL
  collect_admin_password "Console admin password"

  local server_ip
  server_ip="$(curl -4fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
    || echo "<this server's IP>")"

  local wildcard_probe="motherbase-check-${RANDOM}.${DOMAIN}"

  printf '\n%sDNS record to create now:%s\n' "$BOLD" "$RST"
  printf '  A  %-45s →  %s\n' "*.${DOMAIN}" "$server_ip"
  if ! is_subdomain_of "$CONSOLE_DOMAIN" "$DOMAIN"; then
    printf '  A  %-45s →  %s  %s(console outside wildcard)%s\n' "$CONSOLE_DOMAIN" "$server_ip" "$DIM" "$RST"
  fi
  printf '\n'
  printf '  %sThis wildcard covers the Console and every future project:%s\n' "$DIM" "$RST"
  printf '    console.%s, demo.%s, demo-storage.%s\n' "$DOMAIN" "$DOMAIN" "$DOMAIN"
  printf '  After this, users do not add DNS records per project.\n'
  printf '\n'

  if [ "$server_ip" = "<this server's IP>" ]; then
    warn "Could not detect the public IP; skipping DNS propagation check."
  else
    wait_for_dns "$wildcard_probe" "$server_ip"
    if ! is_subdomain_of "$CONSOLE_DOMAIN" "$DOMAIN"; then
      wait_for_dns "$CONSOLE_DOMAIN" "$server_ip"
    fi
  fi

  # Detect deep subdomain: when DOMAIN has 2+ dots (e.g. test.example.com), project
  # domains become foo.test.example.com (3+ labels). Let's Encrypt blocks HTTP-01 for
  # these. A DNS-01 wildcard challenge is required.
  local dot_count
  dot_count="$(printf '%s' "$DOMAIN" | tr -cd '.' | wc -c)"
  if [ "$dot_count" -ge 2 ]; then
    printf '\n%s⚠  Deep subdomain detected%s\n' "$YLW$BOLD" "$RST"
    printf '  Projects under %s will be at %s<name>.%s%s\n' "$DOMAIN" "$DIM" "$DOMAIN" "$RST"
    printf '  Let'\''s Encrypt refuses HTTP-01 certs for 3+ label domains.\n'
    printf '  A DNS-01 wildcard cert is required. Traefik handles it automatically\n'
    printf '  once you supply your DNS provider credentials below.\n\n'
    printf '  Only GoDaddy is pre-configured. For other providers see:\n'
    printf '  https://doc.traefik.io/traefik/https/acme/#providers\n\n'

    local use_dns
    ask_yn "Configure DNS-01 wildcard challenge now?" "y" use_dns
    if [ "$use_dns" = "y" ]; then
      DNS_CHALLENGE_PROVIDER="godaddy"
      CERT_RESOLVER="letsencrypt-dns"
      section "GoDaddy API credentials"
      printf '  Get them at: https://developer.godaddy.com/keys (Production key)\n\n'
      ask_required "GoDaddy API Key"    "${GODADDY_API_KEY:-}"    GODADDY_API_KEY
      ask_required "GoDaddy API Secret" "${GODADDY_API_SECRET:-}" GODADDY_API_SECRET
      ok "DNS-01 challenge configured (letsencrypt-dns resolver)"
    else
      warn "Skipping DNS-01: projects may get self-signed certs until you configure this."
    fi
  fi
}

# ── Write .env: local ──────────────────────────────────────────────────────────
write_env_local() {
  local jwt_secret config_key edge_runtime_token
  jwt_secret="$(gen_hex)"; config_key="$(gen_b64)"; edge_runtime_token="$(gen_hex)"
  cat > .env <<EOF
# Generated by ./setup.sh on $(date -u +'%Y-%m-%dT%H:%M:%SZ')

# --- Server ---
PORT=${API_PORT}
BASE_HOST=localhost:${API_PORT}

# --- Database ---
POSTGRES_PORT=55432
DATABASE_URL=postgresql://postgres:postgres@localhost:55432/app?schema=public

# --- Auth ---
JWT_SECRET=${jwt_secret}
ACCESS_TOKEN_EXP_MIN=15
REFRESH_TOKEN_EXP_DAYS=30

# --- Config encryption ---
CONFIG_ENCRYPTION_KEY=${config_key}

# --- Edge runtime (Deno sidecar; the API and the sidecar share this token) ---
EDGE_RUNTIME_TOKEN=${edge_runtime_token}
EDGE_RUNTIME_URL=http://localhost:9000
EDGE_RUNTIME_CALLBACK_URL=http://localhost:${API_PORT}

# --- CORS (empty = allow all, dev only) ---
CORS_ORIGINS=

# --- Storage (MinIO local) ---
STORAGE_DRIVER=s3
MINIO_PORT=${MINIO_PORT}
MINIO_CONSOLE_PORT=${MINIO_CONSOLE_PORT}
S3_ENDPOINT=http://localhost:${MINIO_PORT}
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET=uploads
S3_PUBLIC_URL=http://localhost:${MINIO_PORT}/uploads

# --- Console ---
CONSOLE_SQL_ENABLED=true
CONSOLE_LOG_BUFFER_SIZE=500

# --- Seed ---
SEED_ADMIN_EMAIL=${ADMIN_EMAIL}
SEED_ADMIN_PASSWORD=${ADMIN_PASSWORD}

# --- SMTP ---
EMAIL_SMTP_HOST=${SMTP_HOST}
EMAIL_SMTP_PORT=${SMTP_PORT}
EMAIL_SMTP_USERNAME=${SMTP_USER}
EMAIL_SMTP_PASSWORD=${SMTP_PASS}
EMAIL_FROM=${SMTP_FROM}

# --- Firebase ---
FIREBASE_PROJECT_ID=${FB_PROJECT_ID}
FIREBASE_CLIENT_EMAIL=${FB_CLIENT_EMAIL}
FIREBASE_PRIVATE_KEY=${FB_PRIVATE_KEY}

# --- APNS ---
APNS_KEY=${APNS_KEY}
APNS_KEY_ID=${APNS_KEY_ID}
APNS_TEAM_ID=${APNS_TEAM_ID}
APNS_BUNDLE_ID=${APNS_BUNDLE_ID}
APNS_PRODUCTION=${APNS_PRODUCTION}
EOF
  ok "Wrote .env"
}

# ── Write .env: VPS ────────────────────────────────────────────────────────────
write_env_vps() {
  # Console-only install. The root .env is just an install marker + the base
  # domain (used to derive PLATFORM_DOMAIN_SUFFIX and to detect the mode on a
  # re-run). Every project's real config (db/api/storage secrets, SMTP, push) 
  # is generated per project by the Console and configured in its own Studio.
  cat > .env <<EOF
# Generated by ./setup.sh on $(date -u +'%Y-%m-%dT%H:%M:%SZ')
# Console-only install marker: per-project settings live in the Console.
# DO NOT COMMIT THIS FILE.

# Base domain: projects are provisioned as <name>.${DOMAIN}
BASE_HOST=${DOMAIN}
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF
  chmod 600 .env
  ok "Wrote .env (mode 600)"
}

# Resolve mutable external references once in VPS mode and persist immutable
# RepoDigests. First-party Motherbase images are built locally and intentionally
# keep their release tags.
is_digest_ref() {
  [[ "$1" =~ @sha256:[0-9a-fA-F]{64}$ ]]
}

resolve_external_digest() {
  local ref="$1" label="$2" digest
  if is_digest_ref "$ref"; then
    printf '%s' "$ref"
    return 0
  fi
  case "$ref" in
    *@sha256:*) die "$label image has an invalid digest; expected repository@sha256:<64 hex characters>." ;;
  esac
  printf 'Resolving immutable digest for %s...\n' "$label" >&2
  docker pull "$ref" >/dev/null || die "Cannot pull $label image '$ref' to resolve its production digest."
  digest="$(docker image inspect "$ref" --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
  is_digest_ref "$digest" \
    || die "$label image '$ref' has no valid RepoDigest. Set an explicit repository@sha256:... reference."
  printf '%s' "$digest"
}

pin_vps_external_images() {
  [ "$MODE" = "vps" ] || return 0
  MINIO_IMAGE="$(resolve_external_digest "$MINIO_IMAGE" MinIO)"
  MINIO_MC_IMAGE="$(resolve_external_digest "$MINIO_MC_IMAGE" MinIO-client)"
  TRAEFIK_IMAGE="$(resolve_external_digest "$TRAEFIK_IMAGE" Traefik)"
  TRAEFIK_DOCKER_PROXY_IMAGE="$(resolve_external_digest "$TRAEFIK_DOCKER_PROXY_IMAGE" Traefik-Docker-proxy)"
  DOCKER_CLI_IMAGE="$(resolve_external_digest "$DOCKER_CLI_IMAGE" Docker-CLI)"
  ok "External production images pinned by RepoDigest"
}

# ── Write console .env ────────────────────────────────────────────────────────
write_console_env() {
  local pw_hash="$1"
  if [ -f deploy/console/.env ]; then
    ok "deploy/console/.env already exists (keeping it"; return
  fi
  local jwt orchestration_secret
  jwt="$(gen_hex)"
  orchestration_secret="$(gen_hex)"
  cat > deploy/console/.env <<EOF
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
CONSOLE_JWT_SECRET=${jwt}
CONSOLE_ADMIN_EMAIL=${ADMIN_EMAIL}
# base64-encoded bcrypt hash) raw hash has '$' which Compose interpolation mangles.
CONSOLE_ADMIN_PASSWORD_HASH_B64=${pw_hash}
CONSOLE_ADMIN_PASSWORD_TEMPORARY=$([ "$ADMIN_PASSWORD_GENERATED" = "1" ] && printf true || printf false)
ORCHESTRATION_SECRET=${orchestration_secret}
API_IMAGE=${API_IMAGE}
CONSOLE_IMAGE=${CONSOLE_IMAGE}
ORCHESTRATION_IMAGE=${ORCHESTRATION_IMAGE}
POSTGRES_IMAGE=${POSTGRES_IMAGE}
MINIO_IMAGE=${MINIO_IMAGE}
MINIO_MC_IMAGE=${MINIO_MC_IMAGE}
DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE}
PLATFORM_DOMAIN_SUFFIX=${PLATFORM_DOMAIN_SUFFIX:-}
CERT_RESOLVER=${CERT_RESOLVER:-letsencrypt}
EOF
  chmod 600 deploy/console/.env
  ok "Wrote deploy/console/.env"
}

hash_console_password() {
  local password="$1"
  printf '%s' "$password" | docker run --rm -i "$CONSOLE_IMAGE" \
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(Buffer.from(require('bcryptjs').hashSync(d.trim(),10)).toString('base64')))"
}

ensure_console_admin_email() {
  [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL="$(get_env_file deploy/console/.env CONSOLE_ADMIN_EMAIL)"
  [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL="$(get_env SEED_ADMIN_EMAIL)"
  [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL="admin@example.com"
}

require_console_password_for_repair() {
  local reason="$1"
  ensure_console_admin_email
  if [ -n "${ADMIN_PASSWORD:-}" ]; then return 0; fi
  if [ "$ASSUME_YES" = "1" ]; then
    die "$reason. Set ADMIN_PASSWORD before running ./setup.sh --yes so setup can repair deploy/console/.env without regenerating .env."
  fi
  warn "$reason. Enter the Console credentials to repair the install."
  ask "Console admin email" "$ADMIN_EMAIL" ADMIN_EMAIL
  ask_secret "Console admin password" ADMIN_PASSWORD
  [ -n "$ADMIN_PASSWORD" ] || die "Console admin password is required."
}

ensure_console_env() {
  local envf=deploy/console/.env
  local pw_hash

  if [ ! -f "$envf" ]; then
    require_console_password_for_repair "deploy/console/.env is missing"
    pw_hash="$(hash_console_password "$ADMIN_PASSWORD")"
    write_console_env "$pw_hash"
    return 0
  fi

  ensure_console_admin_email

  if [ -z "$(get_env_file "$envf" CONSOLE_JWT_SECRET)" ]; then
    set_env_file "$envf" CONSOLE_JWT_SECRET "$(gen_hex)"
    ok "Repaired console JWT secret"
  fi

  if [ -z "$(get_env_file "$envf" CONSOLE_ADMIN_EMAIL)" ]; then
    set_env_file "$envf" CONSOLE_ADMIN_EMAIL "$ADMIN_EMAIL"
    ok "Repaired console admin email"
  fi

  if [ -z "$(get_env_file "$envf" CONSOLE_ADMIN_PASSWORD_HASH_B64)" ] && [ -z "$(get_env_file "$envf" CONSOLE_ADMIN_PASSWORD_HASH)" ]; then
    require_console_password_for_repair "Console password hash is missing from deploy/console/.env"
    pw_hash="$(hash_console_password "$ADMIN_PASSWORD")"
    set_env_file "$envf" CONSOLE_ADMIN_PASSWORD_HASH_B64 "$pw_hash"
    set_env_file "$envf" CONSOLE_ADMIN_PASSWORD_TEMPORARY false
    ok "Repaired console password hash"
  fi

  local orchestration_secret
  orchestration_secret="$(get_env_file "$envf" ORCHESTRATION_SECRET)"
  if [ "${#orchestration_secret}" -lt 32 ]; then
    set_env_file "$envf" ORCHESTRATION_SECRET "$(gen_hex)"
    ok "Repaired internal orchestration secret"
  fi

  set_env_file "$envf" API_IMAGE "$API_IMAGE"
  set_env_file "$envf" CONSOLE_IMAGE "$CONSOLE_IMAGE"
  set_env_file "$envf" ORCHESTRATION_IMAGE "$ORCHESTRATION_IMAGE"
  set_env_file "$envf" POSTGRES_IMAGE "$POSTGRES_IMAGE"
  set_env_file "$envf" MINIO_IMAGE "$MINIO_IMAGE"
  set_env_file "$envf" MINIO_MC_IMAGE "$MINIO_MC_IMAGE"
  set_env_file "$envf" DOCKER_CLI_IMAGE "$DOCKER_CLI_IMAGE"
  if [ "$MODE" = "vps" ]; then
    [ -n "${CONSOLE_DOMAIN:-}" ] || die "CONSOLE_DOMAIN is missing. Set it in .env or pass CONSOLE_DOMAIN=... before re-running setup."
    set_env_file "$envf" CONSOLE_DOMAIN "$CONSOLE_DOMAIN"
    set_env_file "$envf" PLATFORM_DOMAIN_SUFFIX "${PLATFORM_DOMAIN_SUFFIX:-$DOMAIN}"
    set_env_file "$envf" CERT_RESOLVER "${CERT_RESOLVER:-letsencrypt}"
  fi
  chmod 600 "$envf" 2>/dev/null || true
}

ensure_vps_runtime_config() {
  [ -n "${DOMAIN:-}" ] || DOMAIN="$(get_env BASE_HOST)"
  [ -n "$DOMAIN" ] || die ".env exists but BASE_HOST is missing. Choose [r] regenerate or set BASE_HOST manually."

  [ -n "${CONSOLE_DOMAIN:-}" ] || CONSOLE_DOMAIN="$(get_env CONSOLE_DOMAIN)"
  [ -n "${CONSOLE_DOMAIN:-}" ] || CONSOLE_DOMAIN="$(get_env_file deploy/console/.env CONSOLE_DOMAIN)"
  [ -n "${CONSOLE_DOMAIN:-}" ] || CONSOLE_DOMAIN="console.${DOMAIN}"

  [ -n "${ACME_EMAIL:-}" ] || ACME_EMAIL="$(get_env ACME_EMAIL)"
  [ -n "${ACME_EMAIL:-}" ] || ACME_EMAIL="$(get_env_file deploy/traefik/.env ACME_EMAIL)"
  if [ -z "$ACME_EMAIL" ]; then
    if [ "$ASSUME_YES" = "1" ]; then
      die "ACME_EMAIL is missing. Re-run with ACME_EMAIL=you@example.com ./setup.sh --yes."
    fi
    ask_required "Let's Encrypt email" "" ACME_EMAIL
  fi

  [ -f .env ] && set_env_file .env CONSOLE_DOMAIN "$CONSOLE_DOMAIN"
  [ -f .env ] && set_env_file .env ACME_EMAIL "$ACME_EMAIL"
}

ensure_traefik_env() {
  local envf=deploy/traefik/.env
  ensure_vps_runtime_config

  if [ ! -f "$envf" ]; then
    printf 'ACME_EMAIL=%s\nTRAEFIK_IMAGE=%s\nTRAEFIK_DOCKER_PROXY_IMAGE=%s\nTRAEFIK_DASHBOARD_HOST=\nTRAEFIK_DASHBOARD_AUTH=\n' \
      "$ACME_EMAIL" "$TRAEFIK_IMAGE" "$TRAEFIK_DOCKER_PROXY_IMAGE" > "$envf"
    ok "Wrote deploy/traefik/.env"
  else
    set_env_file "$envf" ACME_EMAIL "$ACME_EMAIL"
  fi
  set_env_file "$envf" TRAEFIK_IMAGE "$TRAEFIK_IMAGE"
  set_env_file "$envf" TRAEFIK_DOCKER_PROXY_IMAGE "$TRAEFIK_DOCKER_PROXY_IMAGE"

  ensure_traefik_dns_config
}
# Idempotent repair: guarantees deploy/console/.env carries a valid base64 hash on
# every run. Migrates legacy raw CONSOLE_ADMIN_PASSWORD_HASH and de-corrupts any '$$'
# left by older escaping attempts. No-op when the B64 hash is already clean.
b64enc() { base64 -w0 2>/dev/null || base64 | tr -d '\n'; }
normalize_console_pw_hash() {
  local envf=deploy/console/.env
  [ -f "$envf" ] || return 0
  local b64 decoded raw
  b64="$(grep '^CONSOLE_ADMIN_PASSWORD_HASH_B64=' "$envf" | head -1 | cut -d= -f2-)"
  if [ -n "$b64" ]; then
    decoded="$(printf '%s' "$b64" | base64 -d 2>/dev/null || true)"
    # Already valid bcrypt ($2..$NN$...) with no doubled '$'. Nothing to do.
    case "$decoded" in
      *'$$'*) ;;                       # corrupted → repair below
      '$2'*'$'*) return 0 ;;           # clean → keep
    esac
  fi
  # Derive the true hash: prefer legacy raw line, else the decoded (corrupted) B64.
  raw="$(grep '^CONSOLE_ADMIN_PASSWORD_HASH=' "$envf" | head -1 | cut -d= -f2-)"
  [ -n "$raw" ] || raw="$decoded"
  raw="$(printf '%s' "$raw" | sed 's/\$\$/$/g')"   # collapse $$ → $
  case "$raw" in
    '$2'*) ;;
    *) warn "console .env: no recoverable password hash. Leaving as-is"; return 0 ;;
  esac
  local new_b64; new_b64="$(printf '%s' "$raw" | b64enc)"
  sed -i '/^CONSOLE_ADMIN_PASSWORD_HASH_B64=/d' "$envf"
  printf 'CONSOLE_ADMIN_PASSWORD_HASH_B64=%s\n' "$new_b64" >> "$envf"
  ok "Normalized console password hash (base64)"
}

ensure_traefik_dns_config() {
  local envf=deploy/traefik/.env
  [ -f "$envf" ] || return 0
  [ -n "${DNS_CHALLENGE_PROVIDER:-}" ] || return 0

  for key in DNS_CHALLENGE_PROVIDER GODADDY_API_KEY GODADDY_API_SECRET CERT_RESOLVER; do
    set_env_file "$envf" "$key" "${!key:-}"
  done
  ok "Wrote DNS-01 credentials to deploy/traefik/.env"
}

ensure_console_domain_suffix() {
  local envf=deploy/console/.env
  [ -f "$envf" ] || return 0
  [ -n "${PLATFORM_DOMAIN_SUFFIX:-}" ] || return 0

  if grep -q '^PLATFORM_DOMAIN_SUFFIX=' "$envf"; then
    sed -i "s|^PLATFORM_DOMAIN_SUFFIX=.*|PLATFORM_DOMAIN_SUFFIX=${PLATFORM_DOMAIN_SUFFIX}|" "$envf"
  else
    printf 'PLATFORM_DOMAIN_SUFFIX=%s\n' "$PLATFORM_DOMAIN_SUFFIX" >> "$envf"
  fi

  local cr="${CERT_RESOLVER:-letsencrypt}"
  if grep -q '^CERT_RESOLVER=' "$envf"; then
    sed -i "s|^CERT_RESOLVER=.*|CERT_RESOLVER=${cr}|" "$envf"
  else
    printf 'CERT_RESOLVER=%s\n' "$cr" >> "$envf"
  fi
}

# ── Health check ───────────────────────────────────────────────────────────────
wait_console_healthy() {
  step "Waiting for Console to come up"
  local UP=0
  for i in $(seq 1 60); do
    if console_compose exec -T console node -e \
      "const http=require('http');const req=http.get('http://127.0.0.1:5500/console',r=>process.exit(r.statusCode>=200&&r.statusCode<500?0:1));req.setTimeout(1500,()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1));" \
      >/dev/null 2>&1; then
      UP=1; break
    fi
    sleep 2
  done
  if [ "$UP" = "1" ]; then
    ok "Console healthy"
    return 0
  fi

  warn "Console not healthy after 120s. Recent logs:"
  console_compose logs --tail=80 console || true
  return 1
}

reconcile_running_vps_projects() {
  step "Updating running project APIs"
  local env_file project running healthy updated=0

  # Compose interpolates these image references before selecting the API service.
  export API_IMAGE POSTGRES_IMAGE MINIO_IMAGE MINIO_MC_IMAGE

  for env_file in /srv/projects/*/.env.prod; do
    [ -f "$env_file" ] || continue
    project="$(basename "$(dirname "$env_file")")"
    if [[ ! "$project" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
      warn "Skipping invalid project directory: $project"
      continue
    fi

    running="$(docker ps \
      --filter "label=com.docker.compose.project=$project" \
      --filter "label=com.docker.compose.service=api" \
      --format '{{.Names}}')"
    [ -n "$running" ] || continue

    # Projects created before the Deno sidecar have no EDGE_RUNTIME_TOKEN, and
    # the compose file refuses to interpolate without one. The Console
    # backfills it on its own compose calls; this path bypasses the Console.
    if ! $SUDO grep -q '^EDGE_RUNTIME_TOKEN=.' "$env_file"; then
      $SUDO sed -i '/^EDGE_RUNTIME_TOKEN=/d' "$env_file"
      printf 'EDGE_RUNTIME_TOKEN=%s\n' "$(gen_hex)" | $SUDO tee -a "$env_file" >/dev/null
    fi

    # edge-runtime too: projects created before the sidecar have none running.
    project_compose "$project" "$env_file" up -d --force-recreate --no-deps edge-runtime api \
      || return 1

    healthy=0
    for i in $(seq 1 60); do
      if project_compose "$project" "$env_file" exec -T api node -e \
        "require('http').get('http://127.0.0.1:5001/api/health-check',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
        >/dev/null 2>&1; then
        healthy=1
        break
      fi
      sleep 2
    done

    if [ "$healthy" != "1" ]; then
      warn "Project $project API not healthy after 120s. Recent logs:"
      project_compose "$project" "$env_file" logs --tail=80 api || true
      return 1
    fi

    updated=$((updated + 1))
    ok "Project $project API updated"
  done

  [ "$updated" -gt 0 ] || ok "No running project APIs to update"
}

# ── Image builds ─────────────────────────────────────────────────────────────
# Builds the shared deps image once (native addons compiled a single time),
# then builds the API and Console images in parallel from it. Both project and
# Console runtimes derive from motherbase-deps, so isolated-vm/argon2 no longer
# compile twice.
# CI publishes api/console/postgres/edge-runtime/orchestrator tagged with the commit sha. Pull
# them only when this checkout IS that commit: a dirty tree or an unpushed commit
# would otherwise run an image that does not match the compose files beside it.
# Non-zero return means "build instead".
pull_prebuilt_images() {
  [ "$FORCE_BUILD" = "0" ] || return 1
  local sha pair name
  if [ -e .git ]; then
    sha="$(git rev-parse HEAD 2>/dev/null)" || return 1
    git diff --quiet HEAD 2>/dev/null || return 1
  elif [ -f VERSION ]; then
    sha="$(tr -d '[:space:]' < VERSION)"   # install bundle: the commit it was cut from
  else
    return 1
  fi

  step "Pulling prebuilt images for ${sha:0:12}"
  for pair in "api:$API_IMAGE" "console:$CONSOLE_IMAGE" "postgres:$POSTGRES_IMAGE" "edge-runtime:$EDGE_RUNTIME_IMAGE" "orchestrator:$ORCHESTRATION_IMAGE"; do
    name="${pair%%:*}"
    docker pull -q "$MOTHERBASE_REGISTRY/motherbase-$name:sha-$sha" >/dev/null 2>&1 \
      || { warn "No prebuilt $name image for this commit: building locally"; return 1; }
    docker tag "$MOTHERBASE_REGISTRY/motherbase-$name:sha-$sha" "${pair#*:}"
    # Drop the registry tag: the local tag now holds the image. Left in place it
    # keeps every superseded release tagged, so `docker image prune` (dangling
    # only) never reclaims it, and each deploy leaks five images.
    docker rmi "$MOTHERBASE_REGISTRY/motherbase-$name:sha-$sha" >/dev/null 2>&1 || true
  done
  ok "Prebuilt images pulled"
}


prune_superseeded_images() {
  step "Removing superseed images"
  # Registry `sha-*` tags left by deploys before pull_prebuilt_images untagged
  # them. Without -f, rmi refuses an image a container still uses.
  docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep "^$MOTHERBASE_REGISTRY/motherbase-[a-z-]*:sha-" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
  docker image prune -f >/dev/null || { warn "Prune failed, old images still use the disk"; return 0; }
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  ok "Superseeded images deleted"
}
 
# Source builds only: the console image plus the Docker CLI pinned by $DOCKER_CLI_IMAGE.
build_orchestration_image() {
  step "Building internal orchestration daemon image"
  docker build \
    --build-arg CONSOLE_IMAGE="$CONSOLE_IMAGE" \
    --build-arg DOCKER_CLI_IMAGE="$DOCKER_CLI_IMAGE" \
    -t "$ORCHESTRATION_IMAGE" \
    -f apps/server/console/Orchestration.Dockerfile . \
    || die "Orchestration daemon image build failed"
  docker run --rm --entrypoint docker "$ORCHESTRATION_IMAGE" compose version >/dev/null 2>&1 \
    || die "docker compose plugin not found in orchestration daemon image"
  ok "Orchestration daemon image built ($ORCHESTRATION_IMAGE)"
}

build_images() {
  export DOCKER_BUILDKIT=1

  pull_prebuilt_images && return
  [ -f Dockerfile ] \
    || die "No prebuilt images could be pulled and this install bundle has no sources to build from. Check the connection to ${MOTHERBASE_REGISTRY%%/*}, or clone the repository and run ./setup.sh --build."

  step "Building shared dependency image (native addons compiled once)"
  docker build -t "$DEPS_IMAGE" -f deploy/deps.Dockerfile . \
    || die "Deps image build failed: check deploy/deps.Dockerfile and re-run ./setup.sh"
  ok "Deps image built ($DEPS_IMAGE)"

  step "Building PostgreSQL image"
  docker build -t "$POSTGRES_IMAGE" -f deploy/postgres.Dockerfile . \
    || die "PostgreSQL image build failed: check deploy/postgres.Dockerfile and re-run ./setup.sh"
  ok "PostgreSQL image built ($POSTGRES_IMAGE)"

  # Project stacks reference this image and only fall back to building it
  # inside the orchestration daemon, which cannot reach Docker Hub.
  step "Building edge runtime image"
  docker build -t "$EDGE_RUNTIME_IMAGE" -f deploy/edge-runtime.Dockerfile . \
    || die "Edge runtime image build failed: check deploy/edge-runtime.Dockerfile and re-run ./setup.sh"
  ok "Edge runtime image built ($EDGE_RUNTIME_IMAGE)"

  step "Building API + Console images"
  local api_log console_log api_pid console_pid api_rc=0 console_rc=0
  api_log="$(mktemp)"; console_log="$(mktemp)"

  docker build --build-arg DEPS_IMAGE="$DEPS_IMAGE" -t "$API_IMAGE" -f Dockerfile . >"$api_log" 2>&1 </dev/null &
  api_pid=$!
  docker build --build-arg DEPS_IMAGE="$DEPS_IMAGE" -t "$CONSOLE_IMAGE" -f apps/server/console/Dockerfile . >"$console_log" 2>&1 </dev/null &
  console_pid=$!

  # Both builds are quiet (output goes to the logs; two interleaved BuildKit
  # streams are unreadable), so echo the API log's last line every 5s. A
  # multi-minute step printing nothing at all reads as a silent hang.
  local hb_pid
  while :; do
    printf '\r%s  %-70.70s%s' "$DIM" "$(tail -n 1 "$api_log" 2>/dev/null | tr -d '\r')" "$RST"
    sleep 5
  done &
  hb_pid=$!

  wait "$api_pid" || api_rc=$?
  wait "$console_pid" || console_rc=$?
  kill "$hb_pid" 2>/dev/null || true
  wait "$hb_pid" 2>/dev/null || true
  printf '\r%-74s\r' ""

  if [ "$api_rc" != "0" ]; then
    cat "$api_log" >&2; rm -f "$api_log" "$console_log"
    die "API image build failed: check Dockerfile and re-run ./setup.sh"
  fi
  ok "API image built ($API_IMAGE)"

  if [ "$console_rc" != "0" ]; then
    cat "$console_log" >&2; rm -f "$api_log" "$console_log"
    die "Console image build failed: check apps/server/console/Dockerfile and re-run ./setup.sh"
  fi
  rm -f "$api_log" "$console_log"

  ok "Console image built without Docker CLI ($CONSOLE_IMAGE)"

  build_orchestration_image
}

# ── Start: local ────────────────────────────────────────────────────────────────
start_local() {
  # Local mode mirrors the VPS install: the Console is the single entry point.
  # It runs in dev mode (HTTP, no TLS) on :5500 and provisions each project as
  # its own isolated db + api + storage stack, routed at http://<name>.localhost
  # by a dev Traefik. Projects need no domain. The suffix is forced to localhost.
  local CONSOLE_PORT=5500

  step "Preparing isolated orchestration runtime"
  [ -S /var/run/docker.sock ] || die "Docker socket not found; the internal orchestration daemon cannot start."
  ok "Docker socket available to the orchestration daemon only"

  step "Starting dev Traefik (HTTP :80: projects route at <name>.localhost)"
  docker network inspect traefik_proxy >/dev/null 2>&1 || docker network create traefik_proxy >/dev/null
  compose -f deploy/traefik/docker-compose.dev.yml up -d --force-recreate --remove-orphans
  ok "Traefik up (http://localhost, dashboard :8080)"

  build_images

  # CONSOLE_DOMAIN is unused in dev (we publish :5500 directly), but the same
  # console env file is repaired here so failed first runs can be resumed.
  CONSOLE_DOMAIN="${CONSOLE_DOMAIN:-}"
  ensure_console_env
  normalize_console_pw_hash
  console_compose up -d --force-recreate --remove-orphans
  wait_console_healthy || die "Console failed to start"
  prune_superseeded_images
  ok "Console up (dev)"

  printf '\n%s✅ Console is up!%s\n\n' "$BOLD$GRN" "$RST"
  printf '  %sURLs%s\n' "$BOLD" "$RST"
  printf '    Console        http://localhost:%s/studio\n' "$CONSOLE_PORT"
  printf '    Admin email    %s\n' "$ADMIN_EMAIL"
  printf '    Traefik dash   http://localhost:8080\n\n'
  printf '  %sNext steps%s\n' "$BOLD" "$RST"
  printf '    1. Open the Console:  http://localhost:%s/studio\n' "$CONSOLE_PORT"
  printf '    2. Create a project. No domain needed. It is reachable at\n'
  printf '       http://<name>.localhost once the stack boots (a few seconds).\n\n'
  printf '  %sManage%s\n' "$BOLD" "$RST"
  printf '    Console logs   docker compose -f deploy/console/docker-compose.dev.yml --env-file deploy/console/.env logs -f\n'
  printf '    Traefik logs   docker compose -f deploy/traefik/docker-compose.dev.yml logs -f\n'
  printf '    Reset all      ./deploy/reset.sh\n\n'
}

# ── Start: VPS ──────────────────────────────────────────────────────────────────
start_vps() {
  DOMAIN="${DOMAIN:-$(get_env BASE_HOST)}"
  ensure_vps_runtime_config

  # The Console pre-fills every new project's domain as <name>.<suffix>.
  PLATFORM_DOMAIN_SUFFIX="$DOMAIN"
  export PLATFORM_DOMAIN_SUFFIX

  step "Ensuring runtime permissions"
  # /srv/projects is mounted into the console container; must exist and be writable.
  $SUDO mkdir -p /srv/projects
  $SUDO chmod 755 /srv/projects
  [ -S /var/run/docker.sock ] || die "Docker socket not found; the internal orchestration daemon cannot start."
  ok "Runtime permissions ready; Console will not receive Docker access"

  pin_vps_external_images

  step "Starting Traefik (reverse proxy + Let's Encrypt TLS)"
  open_firewall_ports
  ensure_public_ports_available
  docker network inspect traefik_proxy >/dev/null 2>&1 || docker network create traefik_proxy
  ensure_traefik_env
  compose -f deploy/traefik/docker-compose.yml --env-file deploy/traefik/.env up -d --force-recreate --remove-orphans
  ok "Traefik up (ports 80/443)"

  build_images
  reconcile_running_vps_projects \
    || die "A running project API failed to update"
  ensure_console_env
  normalize_console_pw_hash
  ensure_console_domain_suffix
  console_compose up -d --force-recreate --remove-orphans
  wait_console_healthy || die "Console failed to start"
  prune_superseeded_images
  ok "Console up"

  # No default project stack is started here. The Console is the single entry
  # point: each project gets its own isolated db + api + storage on demand,
  # provisioned from the Console UI (which owns the docker socket).

  printf '\n%s✅ Console is up!%s\n\n' "$BOLD$GRN" "$RST"
  printf '  %sDNS%s: one wildcard record, once:\n' "$BOLD" "$RST"
  printf '    A  *.%s  →  this server\n' "$PLATFORM_DOMAIN_SUFFIX"
  if ! is_subdomain_of "$CONSOLE_DOMAIN" "$PLATFORM_DOMAIN_SUFFIX"; then
    printf '    A  %s  →  this server  %s(console outside wildcard)%s\n' "$CONSOLE_DOMAIN" "$DIM" "$RST"
  fi
  printf '    Covers Console + future projects; no DNS change per project.\n\n'
  printf '  %sNext steps%s\n' "$BOLD" "$RST"
  printf '    1. Open the Console:  https://%s\n' "$CONSOLE_DOMAIN"
  printf '       Admin email: %s\n' "$ADMIN_EMAIL"
  printf '    2. Create your first project. Each project gets its own isolated\n'
  printf '       db + api + storage and its own domain (prefilled as <name>.%s).\n' "$PLATFORM_DOMAIN_SUFFIX"
  printf '    3. Do not touch DNS again for new projects under this domain.\n\n'
  printf '  %sManage%s\n' "$BOLD" "$RST"
  printf '    Console logs   docker compose -f deploy/console/docker-compose.yml --env-file deploy/console/.env logs -f\n'
  printf '    Traefik logs   docker compose -f deploy/traefik/docker-compose.yml --env-file deploy/traefik/.env logs -f\n\n'
  warn "Each project's Studio + /admin are reachable on its own public domain (behind login). Restrict by IP/VPN if sensitive."
}

confirm_fresh_reset() {
  [ "$FRESH_RESET" = "1" ] || return 0
  [ "$FRESH_RESET_CONFIRMED" = "1" ] && return 0
  [ "$ASSUME_YES" = "1" ] && return 0

  local yn
  ask_yn "Fresh reset now? This deletes Docker containers and volumes for this install." "n" yn
  [ "$yn" = "y" ] || die "Fresh reset aborted"
  FRESH_RESET_CONFIRMED=1
}

reset_vps_projects() {
  local projects_dir="/srv/projects"
  local env_file project_dir project

  [ -d "$projects_dir" ] || return 0
  for env_file in "$projects_dir"/*/.env.prod; do
    [ -f "$env_file" ] || continue
    project_dir="$(dirname "$env_file")"
    project="$(basename "$project_dir")"
    warn "Resetting project stack: $project"
    compose -f deploy/docker-compose.prod.yml --env-file "$env_file" -p "$project" down -v --remove-orphans \
      || remove_compose_project_data "$project" || true
    $SUDO rm -rf -- "$project_dir"
  done
}

fresh_reset_install() {
  [ "$FRESH_RESET" = "1" ] || return 0
  confirm_fresh_reset

  step "Fresh reset Docker state"
  if [ "$MODE" = "vps" ]; then
    reset_vps_projects
    if [ -f deploy/console/.env ]; then
      console_compose down -v --remove-orphans || true
    fi
  else
    # Local mode runs the Console (dev) + per-project stacks. Tear the Console
    # down, then remove each project stack by its db/minio volume labels.
    if [ -f deploy/console/.env ]; then
      console_compose down -v --remove-orphans || true
    fi
    # Legacy single-stack (older local installs): harmless if nothing is up.
    compose down -v --remove-orphans 2>/dev/null || true
    local stale_vol
    for stale_vol in $(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E '_(db|minio)_data$' || true); do
      remove_volume_stack_data "$stale_vol" || true
    done
  fi
  ok "Docker containers and volumes reset"
}

load_existing_install() {
  API_PORT="$(get_env PORT)"
  MINIO_CONSOLE_PORT="$(get_env MINIO_CONSOLE_PORT)"
  [ -n "$MINIO_CONSOLE_PORT" ] || MINIO_CONSOLE_PORT="59001"

  local local_base hash_marker
  local_base="$(get_env BASE_HOST)"
  [ -n "$local_base" ] || die ".env exists but BASE_HOST is missing. Choose [r] regenerate or fix .env manually."

  if echo "$local_base" | grep -qE '^localhost(:[0-9]+)?$'; then
    MODE="local"
    [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL="$(get_env SEED_ADMIN_EMAIL)"
    [ -n "${ADMIN_PASSWORD:-}" ] || ADMIN_PASSWORD="$(get_env SEED_ADMIN_PASSWORD)"
  else
    MODE="vps"
    DOMAIN="$local_base"
    [ -n "${ACME_EMAIL:-}" ] || ACME_EMAIL="$(get_env ACME_EMAIL)"
    [ -n "${ACME_EMAIL:-}" ] || ACME_EMAIL="$(get_env_file deploy/traefik/.env ACME_EMAIL)"
    [ -n "${CONSOLE_DOMAIN:-}" ] || CONSOLE_DOMAIN="$(get_env CONSOLE_DOMAIN)"
    [ -n "${CONSOLE_DOMAIN:-}" ] || CONSOLE_DOMAIN="$(get_env_file deploy/console/.env CONSOLE_DOMAIN)"
    [ -n "${CONSOLE_DOMAIN:-}" ] || CONSOLE_DOMAIN="console.${DOMAIN}"
    [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL="$(get_env_file deploy/console/.env CONSOLE_ADMIN_EMAIL)"
    [ -n "${ADMIN_EMAIL:-}" ] || ADMIN_EMAIL="admin@example.com"
  fi

  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    hash_marker="$(get_env_file deploy/console/.env CONSOLE_ADMIN_PASSWORD_HASH_B64)$(get_env_file deploy/console/.env CONSOLE_ADMIN_PASSWORD_HASH)"
    [ -n "$hash_marker" ] && ADMIN_PASSWORD="(set at install)"
  fi
}
# ── Main ────────────────────────────────────────────────────────────────────────
check_docker
check_env

if [ "$ENV_EXISTS" = "0" ]; then
  printf '\n%s══ Backend Setup Wizard ══%s\n' "$BOLD$CYN" "$RST"
  printf '  %sLocal%s: localhost, no domain needed\n' "$BOLD" "$RST"
  printf '  %sVPS%s: real domain + automatic TLS\n\n' "$BOLD" "$RST"

  mode_choice=""
  ask_choice "Mode" "L|v" "$MODE_DEFAULT" mode_choice
  case "$mode_choice" in [Vv]*) MODE="vps" ;; *) MODE="local" ;; esac

  if [ "$MODE" = "local" ]; then
    collect_local
    step "Generating .env"
    write_env_local
  else
    collect_vps
    step "Generating .env"
    # Warn if an existing db_data volume is present: new POSTGRES_PASSWORD will mismatch.
    existing_volumes="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep '_db_data$' || true)"
    if [ -n "$existing_volumes" ]; then
      warn "Existing DB volume(s) detected:"
      for existing_vol in $existing_volumes; do
        warn "  ${existing_vol}"
      done
      warn "A new POSTGRES_PASSWORD will be generated. This WILL break auth against existing data."
      destroy_vol=""
      ask_yn "Destroy existing Docker project data now? (all containers and data will be lost)" "n" destroy_vol
      if [ "$destroy_vol" = "y" ]; then
        for existing_vol in $existing_volumes; do
          remove_volume_stack_data "$existing_vol" \
            || die "Could not destroy Docker data for volume ${existing_vol}"
        done
        ok "Existing Docker data destroyed: fresh DB/storage will be created"
      else
        warn "Keeping volume. If auth fails after setup, run:"
        warn "  ./deploy/reset.sh --yes"
      fi
    fi
    write_env_vps
  fi
else
  load_existing_install
fi

fresh_reset_install

if [ "$MODE" = "local" ]; then
  start_local
else
  start_vps
fi
