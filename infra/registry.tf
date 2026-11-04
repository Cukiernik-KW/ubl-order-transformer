resource "google_artifact_registry_repository" "images" {
  repository_id = "ubl-order-transformer"
  location      = var.region
  format        = "DOCKER"
  description   = "Container images of the UBL order transformer, tagged with the git SHA."

  # Keep the last 5 images only, so the registry does not grow (and cost) forever.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "delete-older"
    action = "DELETE"
    # "Any image": the KEEP policy above wins over DELETE. (older_than = "0s" would mean the same,
    # but the API drops the zero value and Terraform would show a diff on every plan.)
    condition {
      tag_state = "ANY"
    }
  }

  depends_on = [google_project_service.apis]
}

locals {
  image_repo = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}/ubl-order-transformer"
}
