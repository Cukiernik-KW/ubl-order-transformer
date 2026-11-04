#!/usr/bin/env bash
# Smoke test of the built image: HTTP contract, non-root user, image contents, graceful SIGTERM shutdown.
# Used by CI and locally:  bash scripts/docker-smoke.sh [image]   (default: ubl-order-transformer:local)
set -euo pipefail

IMAGE="${1:-ubl-order-transformer:local}"
NAME="ubl-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
BASE="http://localhost:${PORT}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; docker logs "$NAME" >&2 || true; exit 1; }
# Git Bash on Windows rewrites "/app" into a Windows path; MSYS_NO_PATHCONV is a no-op on Linux.
in_container() { MSYS_NO_PATHCONV=1 docker exec "$NAME" "$@"; }

# POSTs a sample file to /messages and checks the status code and a fragment of the body.
expect_post() {
  local file="$1" expected_status="$2" expected_fragment="$3" response status
  response=$(curl -s -w '\n%{http_code}' "$BASE/messages" \
    -H 'content-type: application/json' --data "@${file}")
  status="${response##*$'\n'}"
  [ "$status" = "$expected_status" ] || fail "$file returned $status, expected $expected_status"
  grep -qF "$expected_fragment" <<<"$response" || fail "$file: body lacks $expected_fragment"
  echo "ok   POST /messages $file -> $status"
}

docker run -d --name "$NAME" -p "${PORT}:8080" "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  curl -fs "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "$BASE/health" | grep -q '"ok"' || fail "service did not become healthy"
echo "ok   GET /health"

expect_post samples/message.valid.json 200 '"orderId":"12347"'
expect_post samples/message.missing-order-id.json 400 '"message":"Order ID is required."'

[ "$(in_container id -u)" != "0" ] || fail "container runs as root"
echo "ok   runs as non-root user ($(in_container id -un))"

contents=$(in_container ls -A /app | tr '\n' ' ')
[ "$contents" = "dist node_modules package-lock.json package.json " ] ||
  fail "unexpected files in /app: $contents"
echo "ok   /app contains only: $contents"

# docker stop sends SIGTERM, then SIGKILL after -t seconds (like Cloud Run's ~10 s).
start=$(date +%s)
docker stop -t 10 "$NAME" >/dev/null
elapsed=$(($(date +%s) - start))
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$exit_code" = "0" ] || fail "exit code after SIGTERM was $exit_code (expected 0)"
docker logs "$NAME" 2>&1 | grep -q '"message":"Shutdown complete"' ||
  fail "no 'Shutdown complete' log line"
echo "ok   SIGTERM -> graceful shutdown, exit 0 in ${elapsed}s"

echo "Smoke test passed: $IMAGE"
