#!/usr/bin/env bash
# Smoke test of the built image against a throwaway volume (backlog #36):
# the image starts, serves the SPA, logs the account in, imports a memory
# (a job on a worker thread, backlog #16a — the one thing in the image that
# starts a thread of its own) and — after the container is destroyed and a
# new one started on the same volume — still knows the account and the
# memory. That last step is the point of the volume.
#
# Then the same for the client portal's image (issue #325): it starts, serves its
# page with the neutral name, takes an admin login, creates a client whose private
# token reads that client back, and still has the admin after a new container.
#
#   scripts/smoke-image.sh [image [portal-image]]   # default: tessera:smoke and
#                                                   # tessera-portal:smoke, built here
set -euo pipefail

IMAGE="${1:-tessera:smoke}"
VOLUME="tessera-smoke-$$"
NAME="tessera-smoke-$$"
EMAIL="smoke@example.com"
PASSWORD="smoke-test-password"
PORT="${SMOKE_PORT:-3490}"
PORTAL_IMAGE="${2:-tessera-portal:smoke}"
PORTAL_VOLUME="tessera-portal-smoke-$$"
PORTAL_NAME="tessera-portal-smoke-$$"
PORTAL_PORT="${SMOKE_PORTAL_PORT:-3491}"

TMP="$(mktemp -d)"
cleanup() {
  docker rm -f "$NAME" "$PORTAL_NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" "$PORTAL_VOLUME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

[ $# -ge 1 ] || docker build -t "$IMAGE" .
[ $# -ge 2 ] || docker build --target portal -t "$PORTAL_IMAGE" .

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

# --- the client portal image (issue #325) ------------------------------------

PORTAL_ADMIN="portal-admin@example.com"

start_portal() {
  docker run -d --name "$PORTAL_NAME" -p "$PORTAL_PORT:3300" -v "$PORTAL_VOLUME:/data" "$PORTAL_IMAGE" >/dev/null
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$PORTAL_PORT/client.html" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "portal did not come up" >&2
  docker logs "$PORTAL_NAME" >&2
  exit 1
}

portal_login() {
  curl -fsS -X POST "http://localhost:$PORTAL_PORT/api/admin/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$PORTAL_ADMIN\",\"password\":\"$PASSWORD\"}"
}

docker run --rm -v "$PORTAL_VOLUME:/data" "$PORTAL_IMAGE" \
  node dist/create-admin.js "$PORTAL_ADMIN" "$PASSWORD"

start_portal
curl -fsS "http://localhost:$PORTAL_PORT/client.html" | grep -q '<h1>Translation Portal</h1>' \
  || { echo "/client.html is not the portal page with the neutral name" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORTAL_PORT/api/client/me")" = 401 ] \
  || { echo "/api/client/me is not behind the access token" >&2; exit 1; }
ADMIN_TOKEN="$(portal_login | field token)"
[ -n "$ADMIN_TOKEN" ] || { echo "portal admin login failed" >&2; exit 1; }
CLIENT_TOKEN="$(curl -fsS -X POST "http://localhost:$PORTAL_PORT/api/admin/clients" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Smoke Client","email":"client@example.com"}' | field accessToken)"
[ -n "$CLIENT_TOKEN" ] || { echo "the portal made no client" >&2; exit 1; }
curl -fsS "http://localhost:$PORTAL_PORT/api/client/me" -H "authorization: Bearer $CLIENT_TOKEN" \
  | grep -q 'Smoke Client' || { echo "the client's token does not read the client back" >&2; exit 1; }

docker rm -f "$PORTAL_NAME" >/dev/null
start_portal
[ -n "$(portal_login | field token)" ] || { echo "portal admin lost with the container" >&2; exit 1; }

echo "image smoke test passed"
