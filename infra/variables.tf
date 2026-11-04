variable "project_id" {
  description = "GCP project ID to deploy into."
  type        = string
  # No default: must be set explicitly to avoid deploying to the wrong project.
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry."
  type        = string
  default     = "europe-central2"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]$", var.region))
    error_message = "region must be a GCP region name, e.g. europe-central2."
  }
}

variable "environment" {
  description = "Environment label (dev, prod, ...)."
  type        = string
  default     = "dev"
}

variable "image_tag" {
  description = "Tag of the container image in Artifact Registry (the git SHA, set by scripts/deploy.sh)."
  type        = string
  default     = null
  # null only during the one-time bootstrap (-target on the registry); a full apply requires it.
}

variable "max_delivery_attempts" {
  description = "Push deliveries before Pub/Sub moves a message to the dead-letter topic."
  type        = number
  default     = 5

  validation {
    condition     = var.max_delivery_attempts >= 5 && var.max_delivery_attempts <= 100
    error_message = "Pub/Sub allows max_delivery_attempts between 5 and 100."
  }
}

variable "max_instances" {
  description = "Cloud Run max instances. Safe above 1 because idempotency is shared (Firestore)."
  type        = number
  default     = 2

  validation {
    condition     = var.max_instances >= 1 && var.max_instances <= 2
    error_message = "max_instances is capped at 2 as a cost guardrail."
  }
}

variable "log_level" {
  description = "Service LOG_LEVEL."
  type        = string
  default     = "info"
}
