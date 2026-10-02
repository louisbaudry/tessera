#!/usr/bin/env bash
# Smoke test of the built image against a throwaway volume (backlog #36):
# the image starts, serves the SPA, logs the account in, and — after the
# container is destroyed and a new one started on the same volume — still
# knows the account. That last step is the point of the volume.
#
#   scripts/smoke-image.sh [image]     # default: tessera:smoke, built here
set -euo pipefail

IMAGE="${1:-tessera:smoke}"
VOLUME="tessera-smoke-$$"
NAME="tessera-smoke-$$"
EMAIL="smoke@example.com"
PASSWORD="smoke-test-password"
PORT="${SMOKE_PORT:-3490}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[ $# -ge 1 ] || docker build -t "$IMAGE" .

start() {
  docker run -d --name "$NAME" -p "$PORT:3400" -v "$VOLUME:/data" "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "server did not come up" >&2
  docker logs "$NAME" >&2
  exit 1
}

login() {
  curl -fsS -X POST "http://localhost:$PORT/api/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
}

docker run --rm -v "$VOLUME:/data" "$IMAGE" \
  node dist/create-account.js "$EMAIL" "$PASSWORD"

start
curl -fsS "http://localhost:$PORT/" | grep -q '<div id="root">' \
  || { echo "/ is not the SPA" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/me")" = 401 ] \
  || { echo "/api/me is not behind the gate" >&2; exit 1; }
login | grep -q '"token"' || { echo "login failed" >&2; exit 1; }

docker rm -f "$NAME" >/dev/null
start
login | grep -q '"token"' || { echo "account lost with the container" >&2; exit 1; }

echo "image smoke test passed"
