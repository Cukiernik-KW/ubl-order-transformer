provider "google" {
  project = var.project_id
  region  = var.region

  # Applied to every resource that supports labels (cost reports, ownership).
  default_labels = {
    app         = "ubl-order-transformer"
    environment = var.environment
    managed-by  = "terraform"
  }
}

data "google_project" "this" {
  project_id = var.project_id
}
