# All grants are additive *_member resources on single resources (least privilege). *_binding would
# take over the whole role on the resource and silently remove members granted outside Terraform.

# --- Runtime identity of the Cloud Run service --------------------------------------------------
resource "google_service_account" "runtime" {
  account_id   = "ubl-transformer-run"
  display_name = "UBL order transformer (Cloud Run runtime)"
  depends_on   = [google_project_service.apis]
}

# The service only publishes to its two output topics; it cannot read or publish to the input.
resource "google_pubsub_topic_iam_member" "runtime_publishes" {
  for_each = {
    transformed = google_pubsub_topic.transformed.id
    failed      = google_pubsub_topic.failed.id
  }

  topic  = each.value
  role   = "roles/pubsub.publisher"
  member = google_service_account.runtime.member
}

# --- Identity Pub/Sub uses to call the push endpoint ---------------------------------------------
resource "google_service_account" "push" {
  account_id   = "ubl-transformer-push"
  display_name = "UBL order transformer (Pub/Sub push invoker)"
  depends_on   = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "push_invokes" {
  name     = google_cloud_run_v2_service.transformer.name
  location = google_cloud_run_v2_service.transformer.location
  role     = "roles/run.invoker"
  member   = google_service_account.push.member
}

# --- Pub/Sub service agent: performs dead-lettering --------------------------------------------
# Dead-lettering is done by Google's Pub/Sub service agent, not by our service accounts: it must be
# able to publish to the dead-letter topic and to ack the message on the source subscription.
# (Token creation for push OIDC needs no grant: projects created after 2021-04-08 have it by default.)
locals {
  pubsub_service_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic_iam_member" "service_agent_publishes_dlq" {
  topic  = google_pubsub_topic.failed.id
  role   = "roles/pubsub.publisher"
  member = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "service_agent_subscribes" {
  subscription = google_pubsub_subscription.transformer_push.id
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}
