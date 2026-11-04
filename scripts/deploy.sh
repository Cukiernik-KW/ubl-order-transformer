#!/usr/bin/env bash
# Builds the image, pushes it to Artifact Registry tagged with the git SHA, and applies Terraform.
#
#   bash scripts/deploy.sh            # full deploy (shows the plan, asks before applying)
#
# One-time bootstrap (the registry must exist before the first image can be pushed):
#   terraform -chdir=infra init -backend-config=backend.tfbackend
#   terraform -chdir=infra apply -target=google_artifact_registry_repository.images
#
# Auth: your gcloud user credentials / ADC only; no service-account keys.
set -euo pipefail
cd "$(dirname "$0")/.."

# The tag must describe what is in the image: refuse uncommitted changes to the files that go into it.
if [ -n "$(git status --porcelain -- src package.json package-lock.json tsconfig.json tsconfig.build.json Dockerfile)" ]; then
  echo "Uncommitted changes in files that go into the image; commit them first." >&2
  exit 1
fi

TAG=$(git rev-parse --short HEAD)
REPO=$(terraform -chdir=infra output -raw image_repo 2>/dev/null) || {
  echo "No image_repo output: run the one-time bootstrap first (see the header of this script)." >&2
  exit 1
}
REGISTRY_HOST="${REPO%%/*}"

gcloud auth configure-docker "$REGISTRY_HOST" --quiet
# Cloud Run runs linux/amd64; without --platform an ARM laptop would build an image it cannot run.
docker build --platform linux/amd64 -t "$REPO:$TAG" .
docker push "$REPO:$TAG"

terraform -chdir=infra apply -var "image_tag=$TAG"
