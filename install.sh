#!/usr/bin/env bash
# One-line VPS installer:
#
#   curl -fsSL https://www.motherbase.site/install.sh | bash
#   curl -fsSL https://www.motherbase.site/install.sh | bash -s -- --yes   # unattended, needs DOMAIN and ACME_EMAIL
#
# Downloads the install bundle of the latest release (setup.sh + deploy/, no
# source), checks it against its published SHA-256, unpacks it into $MOTHERBASE_DIR
# (~/motherbase by default) and runs ./setup.sh there in VPS mode. Every argument
# is passed on to setup.sh.
#
# It installs once. An existing install is updated with ./deploy/update.sh, which
# fetches and verifies the same bundle without touching .env or any volume.
#
# Everything lives in main(), called on the last line, so a download cut short
# runs nothing at all instead of half a script.
set -euo pipefail

main() {
  local install_dir="${MOTHERBASE_DIR:-$HOME/motherbase}"
  local bundle_url="${MOTHERBASE_BUNDLE_URL:-https://github.com/JulienGuinot/motherbase/releases/latest/download/motherbase-deploy.tar.gz}"
  local bundle_sha_url="${MOTHERBASE_BUNDLE_SHA256_URL:-$bundle_url.sha256}"

  local unattended=0 arg
  for arg in "$@"; do
    case "$arg" in --yes|-y) unattended=1 ;; esac
  done

  for arg in curl tar sha256sum; do
    command -v "$arg" >/dev/null 2>&1 || die "$arg is required."
  done

  # Same guard as deploy/update.sh, from the other side: setup.sh over an
  # existing install would be a reinstall, and the update path is the one that
  # is known to keep secrets and volumes.
  if [ -e "$install_dir/.env" ]; then
    die "$install_dir already holds an install. Update it with: cd $install_dir && ./deploy/update.sh"
  fi

  # Under `curl | bash`, stdin is this script, so setup.sh's questions would read
  # the pipe. Answer them from the terminal instead, or refuse when there is none.
  local from_tty=0
  if [ "$unattended" = "0" ] && [ ! -t 0 ]; then
    { : < /dev/tty; } 2>/dev/null \
      || die "No terminal to ask the setup questions on. Export DOMAIN and ACME_EMAIL, then re-run with: bash -s -- --yes"
    from_tty=1
  fi

  local staging
  staging="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $staging now, not at trap time
  trap "rm -rf '$staging'" EXIT

  info "Downloading the install bundle"
  curl -fsSL "$bundle_url" -o "$staging/bundle.tar.gz" || die "Could not download $bundle_url"
  curl -fsSL "$bundle_sha_url" -o "$staging/bundle.sha256" \
    || die "Could not download the bundle checksum from $bundle_sha_url. Refusing to install an unverified bundle."

  # The published file is the bare digest, nothing else on the line.
  local expected actual
  expected="$(tr -d '[:space:]' < "$staging/bundle.sha256")"
  [ -n "$expected" ] || die "The published checksum is empty. Refusing to install an unverified bundle."
  actual="$(sha256sum "$staging/bundle.tar.gz" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || die "Bundle checksum mismatch (expected $expected, got $actual). Refusing to install it."
  info "Bundle verified ($actual)"

  # Only a verified bundle reaches the install directory.
  mkdir -p "$install_dir"
  tar xzf "$staging/bundle.tar.gz" -C "$install_dir" || die "The bundle could not be unpacked into $install_dir"
  rm -rf "$staging"
  trap - EXIT

  info "Running setup.sh in $install_dir"
  cd "$install_dir"
  if [ "$from_tty" = "1" ]; then
    ./setup.sh --prod "$@" < /dev/tty
  else
    ./setup.sh --prod "$@"
  fi
}

info() { printf '\033[36m→\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

main "$@"
