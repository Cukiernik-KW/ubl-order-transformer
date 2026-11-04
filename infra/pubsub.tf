resource "google_pubsub_topic" "received" {
  name       = "orders.ubl.received"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "transformed" {
  name       = "orders.transformed"
  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "failed" {
  name       = "orders.failed"
  depends_on = [google_project_service.apis]
}

# The service's input: Pub/Sub pushes every message to Cloud Run with an OIDC token.
resource "google_pubsub_subscription" "transformer_push" {
  name  = "orders.ubl.received.transformer"
  topic = google_pubsub_topic.received.id

  # Must exceed the app's worst-case in-app retry budget (~31 s: publish + DLQ publish,
  # 3 attempts x 5 s timeout + backoff each), otherwise Pub/Sub redelivers a message still in work.
  ack_deadline_seconds = 60

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.transformer.uri}/pubsub/push"
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = google_cloud_run_v2_service.transformer.uri
    }
  }

  # Platform retry layer: redelivery of nacked (500/409) messages with exponential backoff.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  # After max_delivery_attempts the platform moves the raw original message to orders.failed.
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.failed.id
    max_delivery_attempts = var.max_delivery_attempts
  }

  # The default expires a subscription after 31 days without traffic; this one must never expire.
  expiration_policy {
    ttl = ""
  }

  # Both IAM grants for dead-lettering must exist before the policy is used.
  depends_on = [
    google_pubsub_topic_iam_member.service_agent_publishes_dlq,
  ]
}

# Messages published to a topic without subscriptions are dropped. These pull subscriptions keep
# the outputs (orders.failed above all) for operators, the demo and the E2E test.
resource "google_pubsub_subscription" "ops" {
  for_each = {
    transformed = google_pubsub_topic.transformed.id
    failed      = google_pubsub_topic.failed.id
  }

  name                       = "orders.${each.key}.ops"
  topic                      = each.value
  ack_deadline_seconds       = 30
  message_retention_duration = "604800s" # 7 days, the maximum for subscriptions

  expiration_policy {
    ttl = ""
  }
}
