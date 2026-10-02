#!/usr/bin/env bash
# Smoke test of the built image against a throwaway volume (backlog #36):
# the image starts, serves the SPA, logs the account in, imports a memory
# (a job on a worker thread, backlog #16a — the one thing in the image that
# starts a thread of its own) and — after the container is destroyed and a
# new one started on the same volume — still knows the account and the
# memory. That last step is the point of the volume.
#
#   scripts/smoke-image.sh [image]     # default: tessera:smoke, built here
set -euo pipefail

IMAGE="${1:-tessera:smoke}"
VOLUME="tessera-smoke-$$"
NAME="tessera-smoke-$$"
EMAIL="smoke@example.com"
PASSWORD="smoke-test-password"
PORT="${SMOKE_PORT:-3490}"

TMP="$(mktemp -d)"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
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

# The id or token out of a JSON reply, without needing jq on the runner.
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

# A one-unit TMX through the API: 202 and a job, polled to the end.
import_memory() {
  local token="$1" job state
  printf '%s' '<?xml version="1.0"?><tmx version="1.4"><header srclang="en" adminlang="en" datatype="plaintext" segtype="sentence"/><body><tu><tuv xml:lang="en"><seg>Hello</seg></tuv><tuv xml:lang="de"><seg>Hallo</seg></tuv></tu></body></tmx>' >"$TMP/hello.tmx"
  job="$(curl -fsS -X POST "http://localhost:$PORT/api/tms" \
    -H "authorization: Bearer $token" -F name=hello \
    -F "file=@$TMP/hello.tmx;filename=hello.tmx" | field id)"
  [ -n "$job" ] || { echo "the import did not start" >&2; exit 1; }
  for _ in $(seq 1 30); do
    state="$(curl -fsS "http://localhost:$PORT/api/jobs/$job" -H "authorization: Bearer $token" | field state)"
    [ "$state" = done ] && return 0
    [ "$state" = running ] || { echo "the import ended $state" >&2; docker logs "$NAME" >&2; exit 1; }
    sleep 1
  done
  echo "the import did not finish" >&2
  exit 1
}

docker run --rm -v "$VOLUME:/data" "$IMAGE" \
  node dist/create-account.js "$EMAIL" "$PASSWORD"

start
curl -fsS "http://localhost:$PORT/" | grep -q '<div id="root">' \
  || { echo "/ is not the SPA" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/me")" = 401 ] \
  || { echo "/api/me is not behind the gate" >&2; exit 1; }
TOKEN="$(login | field token)"
[ -n "$TOKEN" ] || { echo "login failed" >&2; exit 1; }
import_memory "$TOKEN"

docker rm -f "$NAME" >/dev/null
start
TOKEN="$(login | field token)"
[ -n "$TOKEN" ] || { echo "account lost with the container" >&2; exit 1; }
curl -fsS "http://localhost:$PORT/api/tms" -H "authorization: Bearer $TOKEN" | grep -q '"slug":"hello"' \
  || { echo "memory lost with the container" >&2; exit 1; }

echo "image smoke test passed"
