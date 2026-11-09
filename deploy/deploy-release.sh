#!/usr/bin/env bash
# Executed over SSH from the checked/tested runner checkout, not the VPS copy.
set -euo pipefail

remote_dir="${1:?repository path is required}"
sha="${2:?tested commit is required}"
tag="${3:?release tag is required}"
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
[[ "$remote_dir" = /* ]] || remote_dir="$HOME/$remote_dir"
cd -- "$remote_dir"

me="$(id -un)"
foreign="$(find "$(git rev-parse --git-dir)" ! -user "$me" -printf '%u %p\n' -quit)"
if [ -n "$foreign" ]; then
  echo "Repository contains files owned by another user: $foreign" >&2
  echo "Something ran git or a deploy script as root in this checkout. Repair it once on the VPS:" >&2
  echo "  sudo chown -R $me: $PWD" >&2
  exit 1
fi

# Serialize deploys even when two runners use the same host checkout.
exec 9>"$(git rev-parse --git-path motherbase-deploy.lock)"
flock -n 9 || { echo 'Another deployment holds the repository lock' >&2; exit 1; }
[ -f .env ] || { echo 'Missing .env: install the VPS with setup.sh first' >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo 'Checkout has local changes; refusing to overwrite them' >&2; exit 1; }

# Production moves on release tags only, never on a push to master.
git fetch --no-tags origin "refs/tags/$tag"
[ "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$sha" ] || {
  echo "Release tag $tag does not point at the tested commit $sha" >&2
  exit 1
}
# A queued old job must not roll back a newer release.
latest="$(git ls-remote --tags --refs origin 'v*' | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)"
[ "$latest" = "$tag" ] || {
  echo "Release superseded: $latest is newer than $tag; run the latest release job" >&2
  exit 1
}
git switch --detach "$sha"
[ "$(git rev-parse HEAD)" = "$sha" ]
echo "Deploying release $tag ($sha)"
bash ./setup.sh --yes --skip-dns-check

