#!/usr/bin/env bash
# Nightly copy of the /data volume, taken with the app stopped.
#
# A project, a memory and platform.sqlite are SQLite files in WAL mode: a
# file-level copy of a running database can be torn. For a one-account v1
# service, stopping the app for a few seconds at night is the honest way to
# get a consistent copy; a live `.backup` per file is a later job if the
# service ever needs to stay up around the clock.
#
#   deploy/backup.sh [destination-dir]      # default: /var/backups/tessera
set -euo pipefail

cd "$(dirname "$0")"
DEST="${1:-/var/backups/tessera}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"

# Restart the app even if the copy fails: a failed backup must not leave
# the service down.
trap 'docker compose start tessera >/dev/null' EXIT
docker compose stop tessera >/dev/null
docker compose run --rm --no-deps --entrypoint tar tessera \
  -C /data -czf - . >"$DEST/tessera-data-$STAMP.tar.gz"

# Keep two weeks.
find "$DEST" -name 'tessera-data-*.tar.gz' -mtime +14 -delete
echo "wrote $DEST/tessera-data-$STAMP.tar.gz"
