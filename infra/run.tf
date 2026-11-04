resource "google_cloud_run_v2_service" "transformer" {
  name     = "ubl-order-transformer"
  location = var.region

  # Reachable over the internet, but no allUsers invoker: every request needs an identity token
  # of a principal with roles/run.invoker (the push SA). Cloud Run verifies it, not the app.
  ingress = "INGRESS_TRAFFIC_ALL"

  # The provider defaults to true, which would block `terraform destroy` of this demo stack.
  deletion_protection = false

  template {
    service_account = google_service_account.runtime.email
    timeout         = "60s"

    scaling {
      min_instance_count = 0 # cost guardrail: scale to zero when idle
      max_instance_count = var.max_instances
    }

    containers {
      image = "${local.image_repo}:${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # CPU only while handling requests (request-based billing)
        startup_cpu_boost = true
      }

      env {
        name  = "PUBLISHER"
        value = "pubsub"
      }
      env {
        name  = "OUTPUT_TOPIC"
        value = google_pubsub_topic.transformed.name
      }
      env {
        name  = "DLQ_TOPIC"
        value = google_pubsub_topic.failed.name
      }
      env {
        name  = "IDEMPOTENCY_STORE"
        value = "firestore"
      }
      env {
        name  = "FIRESTORE_DATABASE_ID"
        value = google_firestore_database.default.name
      }
      env {
        name  = "IDEMPOTENCY_COLLECTION"
        value = local.idempotency_collection
      }
      env {
        name  = "LOG_LEVEL"
        value = var.log_level
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 2
        failure_threshold = 15
      }
    }
  }

  lifecycle {
    precondition {
      condition     = var.image_tag != null
      error_message = "image_tag is required (use scripts/deploy.sh, which sets it to the git SHA)."
    }
  }

  # The first message must not race the Firestore grant.
  depends_on = [google_project_service.apis, google_project_iam_member.runtime_uses_firestore]
}
