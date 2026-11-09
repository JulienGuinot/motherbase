#!/bin/sh
# PKG-13: the API used to run as root. The server itself has no reason to --
# it listens on 5001, not a privileged port, and writes only to its two mounted
# volumes.
#
# This stays root just long enough to make those volumes writable by the
# unprivileged account, then drops for good. The chown cannot move into the
# image: Docker only copies the image's ownership onto a named volume the first
# time it is mounted, so an instance that was deployed before this change has
# root-owned backups/ and data/ directories, and a plain `USER node` would have
# turned "backups work" into "backups fail with EACCES" on upgrade.
#
# The root filesystem is read-only (see deploy/docker-compose.prod.yml), so
# these two mounts and /tmp are the only writable paths either way.
#
# That file drops every capability, so it has to add back the three this needs
# while it is still root: CHOWN for the loop below, SETUID and SETGID for the
# drop itself. The uid change clears them, so the server inherits none. A
# deployment that drops them without adding these back fails here, loudly,
# rather than running the server as root again.
set -e

for dir in /app/backups /app/data; do
  [ -d "$dir" ] || continue
  # Already ours: a fresh volume inherited the image's ownership, an earlier
  # boot fixed it, or the path is not a mount at all. That last case matters --
  # the root filesystem is read-only, so chowning it would fail and warn about
  # a directory that was never going to be written to.
  [ "$(stat -c %u "$dir")" = "$(id -u node)" ] && continue
  chown node:node "$dir" || echo "warning: could not chown $dir; writes to it may fail" >&2
done

# --init-groups so the supplementary groups are the account's own, not root's.
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
