terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State holds the generated database password and secret values. Use a private, versioned bucket:
  #
  # backend "gcs" {
  #   bucket = "my-org-terraform-state"
  #   prefix = "aerotrace/prod"
  # }
}

provider "google" {
  project        = var.project_id
  region         = var.region
  default_labels = local.labels
}
