#!/usr/bin/env bash
# Nightly copy of the /data volumes (the CAT app's and the portal's), taken with both stopped.
#
# A project, a memory and platform.sqlite are SQLite files in WAL mode: a
# file-level copy of a running database can be torn. For a one-account v1
# service, stopping the app for a few seconds at night is the honest way to
# get a consistent copy; a live `.backup` per file is a later job if the
# service ever needs to stay up around the clock.
#
#   deploy/backup.sh [destination-dir]      # default: /var/backups/tessera (needs root;
#                                           # a first test run as a normal user: ~/backups)
set -euo pipefail

cd "$(dirname "$0")"
DEST="${1:-/var/backups/tessera}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"

# Restart both even if a copy fails: a failed backup must not leave the service down.
trap 'docker compose start tessera portal >/dev/null' EXIT
docker compose stop tessera portal >/dev/null

# One archive per service: its file name, and the compose service whose /data it is.
for service in tessera portal; do
  OUT="$DEST/$service-data-$STAMP.tar.gz"
  # -T: no pseudo-terminal. With one, Docker rewrites \n to \r\n in the stream and
  # the archive is silently corrupt.
  docker compose run -T --rm --no-deps --entrypoint tar "$service" \
    -C /data -czf - . >"$OUT"

  # A truncated or corrupt archive must fail the script, not sit there until the day it is needed.
  tar -tzf "$OUT" >/dev/null

  # Keep two weeks.
  find "$DEST" -name "$service-data-*.tar.gz" -mtime +14 -delete
  echo "wrote $OUT"
done
