# Shared idempotency store: every Cloud Run instance claims messageIds in the same database.
locals {
  idempotency_collection = "idempotency"
}

# (default) because the free tier applies only to the default database; the project has no other use for it.
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # Demo stack: `terraform destroy` must really delete it (the provider default is ABANDON).
  deletion_policy         = "DELETE"
  delete_protection_state = "DELETE_PROTECTION_DISABLED"

  depends_on = [google_project_service.apis]
}

# Firestore deletes documents whose expiresAt is in the past (eventually, within ~24 h; the adapter
# checks expiry itself). The empty index_config exempts the field from single-field indexing, which
# Google recommends for TTL timestamps written at a high rate.
resource "google_firestore_field" "idempotency_ttl" {
  database   = google_firestore_database.default.name
  collection = local.idempotency_collection
  field      = "expiresAt"

  ttl_config {}
  index_config {}
}

# Firestore has no per-collection IAM; datastore.user is the narrowest predefined role (read/write
# documents, no admin). The condition limits it to this one database instead of the whole project.
resource "google_project_iam_member" "runtime_uses_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = google_service_account.runtime.member

  condition {
    title       = "idempotency-database-only"
    description = "Only the database holding the idempotency store."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.default.name}\""
  }
}
