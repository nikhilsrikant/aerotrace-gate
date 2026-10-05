# AeroTrace Gate on Google Cloud: Cloud Run (web, worker services and a migrate job) with
# Direct VPC egress, Cloud SQL PostgreSQL on a private IP, GCS evidence, Cloud KMS signing,
# Secret Manager, Cloud Monitoring/Trace via an OpenTelemetry collector sidecar.
#
# Files:
#   network.tf        VPC, subnet, private services access for Cloud SQL
#   database.tf       Cloud SQL
#   security.tf       KMS, secrets, service accounts and IAM, GitHub Workload Identity Federation
#   compute.tf        Artifact Registry, Cloud Run services and job
#   observability.tf  notification channel and alert policies
#   main.tf           (this file) APIs, locals, evidence bucket

data "google_project" "this" {
  project_id = var.project_id
}

resource "random_string" "suffix" {
  length  = 4
  upper   = false
  special = false
}

locals {
  name   = "${var.name_prefix}-${var.environment}"
  suffix = random_string.suffix.result

  labels = merge({
    application = "aerotrace-gate"
    environment = var.environment
    managed-by  = "terraform"
  }, var.labels)

  web_service_name    = "${local.name}-web"
  worker_service_name = "${local.name}-worker"
  migrate_job_name    = "${local.name}-migrate"

  # Cloud Run URLs are deterministic: https://<service>-<project number>.<region>.run.app
  default_url = "https://${local.web_service_name}-${data.google_project.this.number}.${var.region}.run.app"
  public_url  = var.public_url != "" ? var.public_url : local.default_url
}

# ---------------------------------------------------------------- APIs

resource "google_project_service" "enabled" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "cloudtrace.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------- evidence bucket

# Optional customer-managed key for the bucket.
resource "google_kms_crypto_key" "bucket" {
  count = var.bucket_cmek ? 1 : 0

  name            = "aerotrace-evidence"
  key_ring        = google_kms_key_ring.main.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 days
  labels          = local.labels
}

data "google_storage_project_service_account" "gcs" {
  depends_on = [google_project_service.enabled]
}

resource "google_kms_crypto_key_iam_member" "gcs_cmek" {
  count = var.bucket_cmek ? 1 : 0

  crypto_key_id = google_kms_crypto_key.bucket[0].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${data.google_storage_project_service_account.gcs.email_address}"
}

resource "google_storage_bucket" "evidence" {
  name                        = "${var.project_id}-${local.name}-evidence"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  dynamic "encryption" {
    for_each = var.bucket_cmek ? [1] : []
    content {
      default_kms_key_name = google_kms_crypto_key.bucket[0].id
    }
  }

  lifecycle_rule {
    condition {
      age = var.evidence_archive_days
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }

  lifecycle_rule {
    condition {
      with_state                 = "ARCHIVED"
      days_since_noncurrent_time = var.evidence_archive_days
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }

  labels = local.labels

  depends_on = [google_kms_crypto_key_iam_member.gcs_cmek]
}
