locals {
  required_apis = toset([
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "firestore.googleapis.com",
  ])
}

# Keys are API names, so removing one does not shift or recreate the others (unlike count).
resource "google_project_service" "apis" {
  for_each = local.required_apis

  service = each.value

  # APIs are project-wide and other workloads may use them: never disable on destroy.
  disable_on_destroy = false
}
