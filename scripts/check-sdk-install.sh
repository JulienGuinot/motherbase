#!/usr/bin/env bash
# Install the packed SDK into an empty project, the way an app does, with npm's
# default peer resolution. The monorepo installs with --legacy-peer-deps, so its
# own `npm ci` cannot see a peer set that consumers cannot resolve: 2.2.1 shipped
# one, and `npm install` crashed or never finished on npm 10, 11 and 12.
#
# Run after `npm run build`: the tarballs are packed from the built dist.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for pkg in contracts client ssr; do
  npm pack "$root/packages/$pkg" --ignore-scripts --pack-destination "$work" --silent >/dev/null
done

cd "$work"
echo '{ "name": "sdk-install-check", "version": "0.0.0", "private": true }' > package.json
# The timeout is the check for the npm 11/12 failure mode, which spins forever.
timeout 300 npm install --no-audit --no-fund ./motherbase-*.tgz socket.io-client@^4
# Exits non-zero on an invalid (unsatisfied) peer, which npm install only warns about.
npm ls --all >/dev/null
echo "SDK installs cleanly with npm $(npm --version)."
