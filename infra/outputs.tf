output "service_url" {
  description = "Cloud Run URL (requires an identity token with roles/run.invoker)."
  value       = google_cloud_run_v2_service.transformer.uri
}

output "image_repo" {
  description = "Artifact Registry image path; scripts/deploy.sh pushes <image_repo>:<git sha>."
  value       = local.image_repo
}

output "input_topic" {
  value = google_pubsub_topic.received.name
}

output "ops_subscriptions" {
  description = "Pull subscriptions on the output topics (inspection, demo, E2E)."
  value       = { for key, sub in google_pubsub_subscription.ops : key => sub.name }
}
