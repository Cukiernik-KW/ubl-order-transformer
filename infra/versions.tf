terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }

  # Partial backend configuration: the bucket name is not hardcoded (backend blocks cannot use
  # variables). Pass it at init time:  terraform init -backend-config=backend.tfbackend
  backend "gcs" {
    prefix = "ubl-order-transformer/dev"
  }
}
