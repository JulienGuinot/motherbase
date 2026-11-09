#!/usr/bin/env bash
# Update an existing install in place. Keeps every volume, every .env and every
# provisioned project: pulls the branch, rebuilds the images and recreates only
# the motherbase services. Migrations run when each API container boots.
#
# This is the update path. `./deploy/reset.sh` is NOT: it exists to return the
# machine to a fresh checkout and deletes volumes, .env files and /srv/projects.
#
#   ./deploy/update.sh              # pull the current branch, then redeploy
#   ./deploy/update.sh --no-pull    # redeploy the working tree as it is
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

pull=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=0 ;;
    -h|--help)
      echo "Usage: ./deploy/update.sh [--no-pull]"
      echo "Updates this install in place, keeping all data. Reinstall is ./setup.sh;"
      echo "./deploy/reset.sh destroys data and is not an update path."
      echo
      echo "  --no-pull   skip the git pull and redeploy the current working tree"
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

# setup.sh only preserves an install when it can read the existing .env. Without
# it the wizard would generate a fresh POSTGRES_PASSWORD, which no longer opens
# the existing database volume. Stop here rather than let that happen.
[ -f .env ] || die ".env is missing: this is not an existing install. Run ./setup.sh to install, and restore .env from your backup if you had one."

if [ "$pull" = "1" ] && [ ! -e .git ]; then
  # Install bundle, not a checkout: lay the newest bundle over this directory.
  # It carries no .env, so every secret and volume stays as it is.
  #
  # PKG-3: this used to be `curl ... | tar xz`, which extracted whatever
  # arrived straight over setup.sh, deploy/ and the compose files -- the
  # scripts that hold this machine's root. Download, verify, then extract:
  # anything that fails leaves the current install untouched.
  bundle_url="${MOTHERBASE_BUNDLE_URL:-https://github.com/JulienGuinot/motherbase/releases/latest/download/motherbase-deploy.tar.gz}"
  bundle_sha_url="${MOTHERBASE_BUNDLE_SHA256_URL:-$bundle_url.sha256}"

  staging="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $staging now, not at trap time
  trap "rm -rf '$staging'" EXIT

  info "Fetching the latest install bundle"
  curl -fsSL "$bundle_url" -o "$staging/bundle.tar.gz" \
    || die "Could not download the install bundle. Re-run with --no-pull to redeploy what is here."

  info "Verifying the bundle checksum"
  curl -fsSL "$bundle_sha_url" -o "$staging/bundle.sha256" \
    || die "Could not download the bundle checksum from $bundle_sha_url. Refusing to install an unverified bundle."

  # The published file is the bare digest, nothing else on the line.
  expected="$(tr -d '[:space:]' < "$staging/bundle.sha256")"
  [ -n "$expected" ] || die "The published checksum is empty. Refusing to install an unverified bundle."
  actual="$(sha256sum "$staging/bundle.tar.gz" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || die "Bundle checksum mismatch (expected $expected, got $actual). Refusing to install it."

  # Only now does anything touch the install directory.
  info "Unpacking the bundle"
  tar xzf "$staging/bundle.tar.gz" \
    || die "The bundle could not be unpacked. The install is unchanged; re-run with --no-pull to redeploy what is here."

  rm -rf "$staging"
  trap - EXIT
elif [ "$pull" = "1" ]; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [ "$branch" != "HEAD" ] || die "Detached HEAD: check out a branch, or re-run with --no-pull."
  git diff --quiet && git diff --cached --quiet \
    || die "Uncommitted changes in the repo. Commit or stash them, or re-run with --no-pull."
  info "Pulling origin/$branch"
  git pull --ff-only origin "$branch"
fi

info "Redeploying (volumes, .env files and /srv/projects are left untouched)"
./setup.sh --yes

info "Update complete."
