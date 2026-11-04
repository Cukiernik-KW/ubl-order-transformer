#!/usr/bin/env bash
# Runs a command with the Firestore emulator (in Docker, so no local Java/gcloud components needed).
#   npm run test:firestore                                      # Firestore adapter tests only
#   bash scripts/with-firestore-emulator.sh npm run coverage     # everything (what CI runs)
set -euo pipefail

# Pinned by digest (the "emulators" tag moves); override with FIRESTORE_EMULATOR_IMAGE.
IMAGE="${FIRESTORE_EMULATOR_IMAGE:-gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:c3b114528245d315af73d92d95d8e2fed9747ce29003ad46232f22b4542da036}"
PORT="${FIRESTORE_EMULATOR_PORT:-8686}"
NAME="firestore-emulator-$$"

docker run -d --rm --name "$NAME" -p "${PORT}:8080" "$IMAGE" \
  gcloud emulators firestore start --host-port=0.0.0.0:8080 >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

# Poll until the emulator answers (it prints "Ok" on its root URL), no fixed sleep.
for _ in $(seq 1 60); do
  curl -fs "http://localhost:${PORT}" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fs "http://localhost:${PORT}" >/dev/null || { docker logs "$NAME" >&2; exit 1; }

FIRESTORE_EMULATOR_HOST="localhost:${PORT}" "$@"
