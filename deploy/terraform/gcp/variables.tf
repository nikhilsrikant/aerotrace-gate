# ---------------------------------------------------------------- naming

variable "project_id" {
  description = "Google Cloud project to deploy into."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, KMS, the bucket and Artifact Registry."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = "Prefix for resource names. Short, because service account IDs stop at 30 characters."
  type        = string
  default     = "aerotrace"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.name_prefix))
    error_message = "name_prefix must be 2-12 characters: lowercase letters, digits, hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Environment name used in names and labels (prod, staging, pilot)."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.environment))
    error_message = "environment must be 2-8 lowercase letters or digits."
  }
}

variable "labels" {
  description = "Extra labels added to every resource that supports them."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------- application

variable "public_url" {
  description = "The https URL people open. Empty means the Cloud Run URL of the web service. Passkeys are bound to this host; pick the final one before anyone enrols."
  type        = string
  default     = ""

  validation {
    condition     = var.public_url == "" || can(regex("^https://[^/]+$", var.public_url))
    error_message = "public_url must be empty or https://host with no trailing slash."
  }
}

variable "admin_email" {
  description = "Email of the first administrator, created by the migrate job on an empty database."
  type        = string
}

variable "admin_name" {
  description = "Display name of the first administrator."
  type        = string
  default     = "Gate Administrator"
}

variable "image_tag" {
  description = "Image tag used when Terraform creates the services and job. Later releases are rolled by the GitHub workflow and Terraform ignores the image."
  type        = string
  default     = "2.3.0"
}

variable "image_name" {
  description = "Image name inside the Artifact Registry repository."
  type        = string
  default     = "aerotrace-gate"
}

variable "extra_environment" {
  description = "Extra non-secret environment variables for web, worker and migrate (OIDC_ISSUER, LLM_PROVIDER and so on)."
  type        = map(string)
  default     = {}
}

variable "connector_allowed_hosts" {
  description = "Comma-separated hosts evidence connectors may reach on private addresses or plain http (an internal GitHub Enterprise or Jira Data Center). Sets CONNECTOR_ALLOWED_HOSTS on web and worker when not empty."
  type        = string
  default     = ""
}

variable "secret_delivery" {
  description = "\"ref\": set <NAME>_REF=gcp-sm://projects/<p>/secrets/<s>/versions/latest and let the app read Secret Manager (the runtime contract). \"platform\": Cloud Run injects DATABASE_URL, SESSION_SECRET and ADMIN_PASSWORD from Secret Manager as environment variables."
  type        = string
  default     = "ref"

  validation {
    condition     = contains(["ref", "platform"], var.secret_delivery)
    error_message = "secret_delivery must be \"ref\" or \"platform\"."
  }
}

variable "allow_unauthenticated" {
  description = "Let anyone on the internet invoke the web service. The app does its own sign-in and passkey checks; turn this off if an IAP or load balancer in front handles access."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- network

variable "subnet_cidr" {
  description = "CIDR of the subnet Cloud Run's Direct VPC egress uses."
  type        = string
  default     = "10.60.0.0/20"
}

variable "psa_prefix_length" {
  description = "Size of the private services access range reserved for Cloud SQL."
  type        = number
  default     = 20
}

# ---------------------------------------------------------------- database

variable "db_tier" {
  description = "Cloud SQL machine tier."
  type        = string
  default     = "db-custom-2-7680"
}

variable "db_edition" {
  description = "Cloud SQL edition. ENTERPRISE works with db-custom tiers; ENTERPRISE_PLUS needs db-perf-optimized tiers."
  type        = string
  default     = "ENTERPRISE"
}

variable "db_availability_type" {
  description = "REGIONAL runs a standby in another zone; ZONAL is a single instance."
  type        = string
  default     = "REGIONAL"

  validation {
    condition     = contains(["REGIONAL", "ZONAL"], var.db_availability_type)
    error_message = "db_availability_type must be REGIONAL or ZONAL."
  }
}

variable "db_disk_size_gb" {
  description = "Initial disk size in GB (auto-resize is on)."
  type        = number
  default     = 50
}

variable "db_backup_retention_count" {
  description = "Number of daily backups kept."
  type        = number
  default     = 14
}

variable "db_pitr_days" {
  description = "Days of transaction logs kept for point-in-time recovery (1-7 on Enterprise edition)."
  type        = number
  default     = 7
}

variable "deletion_protection" {
  description = "Deletion protection on Cloud SQL (Terraform and API level) and the Cloud Run services and job."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- KMS and storage

variable "kms_protection_level" {
  description = "Protection level of the signing key: HSM or SOFTWARE."
  type        = string
  default     = "HSM"

  validation {
    condition     = contains(["HSM", "SOFTWARE"], var.kms_protection_level)
    error_message = "kms_protection_level must be HSM or SOFTWARE."
  }
}

variable "signing_key_version" {
  description = "Which version of the signing key the app signs with. Version 1 is created with the key; raise this after creating a new version to rotate."
  type        = number
  default     = 1
}

variable "bucket_cmek" {
  description = "Encrypt the evidence bucket with a customer-managed KMS key instead of Google-managed encryption."
  type        = bool
  default     = false
}

variable "evidence_archive_days" {
  description = "Days after which evidence objects move to the ARCHIVE storage class (still readable, with retrieval fees)."
  type        = number
  default     = 365
}

# ---------------------------------------------------------------- compute

variable "web_min_instances" {
  description = "Minimum web instances. 1 or more avoids cold starts."
  type        = number
  default     = 1
}

variable "web_max_instances" {
  description = "Maximum web instances."
  type        = number
  default     = 10
}

variable "web_cpu" {
  description = "CPU limit for the web container."
  type        = string
  default     = "1"
}

variable "web_memory" {
  description = "Memory limit for the web container."
  type        = string
  default     = "2Gi"
}

variable "worker_min_instances" {
  description = "Minimum worker instances. Keep at 1 or more so schedules run."
  type        = number
  default     = 1
}

variable "worker_max_instances" {
  description = "Maximum worker instances."
  type        = number
  default     = 5
}

variable "worker_cpu" {
  description = "CPU limit for the worker container."
  type        = string
  default     = "2"
}

variable "worker_memory" {
  description = "Memory limit for the worker container."
  type        = string
  default     = "4Gi"
}

variable "collector_cpu" {
  description = "CPU limit for each OpenTelemetry collector sidecar."
  type        = string
  default     = "1"
}

variable "collector_memory" {
  description = "Memory limit for each OpenTelemetry collector sidecar."
  type        = string
  default     = "512Mi"
}

variable "otel_collector_image" {
  description = "OpenTelemetry collector (contrib) image for the sidecars."
  type        = string
  default     = "otel/opentelemetry-collector-contrib:0.111.0"
}

# ---------------------------------------------------------------- alerts

variable "alert_email" {
  description = "Email for the alert notification channel. Empty means alerts have no channel."
  type        = string
  default     = ""
}

variable "enable_app_metric_alerts" {
  description = "Create the alert on custom.googleapis.com/aerotrace/aerotrace.approvals.oldest_age_seconds. Cloud Monitoring rejects alerts on metrics it has never seen, so turn this on after the app has run for a few minutes."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------- GitHub deploy

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must look like owner/name."
  }
}

variable "github_branch" {
  description = "Branch allowed to deploy (v* tags are also allowed)."
  type        = string
  default     = "main"
}
