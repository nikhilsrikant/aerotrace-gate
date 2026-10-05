# ---------------------------------------------------------------- naming

variable "name_prefix" {
  description = "Prefix for resource names. Lowercase letters, digits and hyphens; short, because Container Apps names stop at 32 characters."
  type        = string
  default     = "aerotrace"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.name_prefix))
    error_message = "name_prefix must be 2-12 characters: lowercase letters, digits, hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Environment name used in names and tags (prod, staging, pilot)."
  type        = string
  default     = "prod"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,7}$", var.environment))
    error_message = "environment must be 2-8 lowercase letters or digits."
  }
}

variable "subscription_id" {
  description = "Azure subscription to deploy into."
  type        = string
}

variable "location" {
  description = "Azure region. Pick one with availability zones if you want zone redundancy."
  type        = string
  default     = "eastus2"
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------- application

variable "public_url" {
  description = "The https URL people open. Empty means https://<custom_domain> if set, otherwise the Container Apps default hostname. Passkeys are bound to this host; pick the final one before anyone enrols."
  type        = string
  default     = ""

  validation {
    condition     = var.public_url == "" || can(regex("^https://[^/]+$", var.public_url))
    error_message = "public_url must be empty or https://host with no trailing slash."
  }
}

variable "custom_domain" {
  description = "Optional custom hostname for the web app (e.g. gate.example.com). Create the DNS records first; see docs/cloud/azure.md."
  type        = string
  default     = ""
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
  description = "Image tag used when Terraform creates the apps and job. Later releases are rolled by the GitHub workflow and Terraform ignores the image."
  type        = string
  default     = "2.3.0"
}

variable "image_repository" {
  description = "Repository name inside the registry."
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
  description = "\"ref\": set <NAME>_REF=azure-kv://<vault>/<secret> and let the app read Key Vault with its managed identity (the runtime contract). \"platform\": Container Apps pulls the Key Vault secrets and injects DATABASE_URL, SESSION_SECRET and ADMIN_PASSWORD as environment variables."
  type        = string
  default     = "ref"

  validation {
    condition     = contains(["ref", "platform"], var.secret_delivery)
    error_message = "secret_delivery must be \"ref\" or \"platform\"."
  }
}

variable "evidence_cold_after_days" {
  description = "Days after which evidence blobs move to the Cold tier (still online). 0 disables the rule."
  type        = number
  default     = 365
}

variable "storage_replication" {
  description = "Storage account replication: ZRS, GZRS, RAGZRS, LRS..."
  type        = string
  default     = "GZRS"
}

variable "storage_public_network_access" {
  description = "Allow the storage account's public endpoint. Off by default; the apps use the private endpoint."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------- network

variable "vnet_cidr" {
  description = "Address space for the VNet."
  type        = string
  default     = "10.50.0.0/16"
}

variable "allowed_cidrs" {
  description = "CIDR ranges allowed to reach the web app. [\"0.0.0.0/0\"] means no restriction."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---------------------------------------------------------------- database

variable "db_sku" {
  description = "PostgreSQL Flexible Server SKU. High availability needs General Purpose or Memory Optimized."
  type        = string
  default     = "GP_Standard_D2ds_v5"
}

variable "db_storage_mb" {
  description = "Database storage in MB (auto-grow is on)."
  type        = number
  default     = 65536
}

variable "db_zone" {
  description = "Availability zone for the primary server."
  type        = string
  default     = "1"
}

variable "db_zone_redundant_ha" {
  description = "Run a zone-redundant standby."
  type        = bool
  default     = true
}

variable "db_standby_zone" {
  description = "Availability zone for the standby when zone-redundant HA is on."
  type        = string
  default     = "2"
}

variable "db_backup_retention_days" {
  description = "Backup retention in days (7-35)."
  type        = number
  default     = 14
}

variable "db_geo_redundant_backup" {
  description = "Copy backups to the paired region. Can only be set when the server is created."
  type        = bool
  default     = true
}

variable "deletion_protection" {
  description = "Put CanNotDelete locks on the database, storage account and key vault."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------- Key Vault

variable "key_vault_sku" {
  description = "Key Vault SKU. \"premium\" is required for an HSM-backed signing key."
  type        = string
  default     = "premium"

  validation {
    condition     = contains(["standard", "premium"], var.key_vault_sku)
    error_message = "key_vault_sku must be standard or premium."
  }
}

variable "hsm" {
  description = "Make the signing key HSM-backed (EC-HSM). Only takes effect with key_vault_sku = premium."
  type        = bool
  default     = true
}

variable "signing_key_rotation_days" {
  description = "Rotate the signing key automatically every N days. 0 turns rotation off. The app keeps every public key it has used."
  type        = number
  default     = 0
}

variable "key_vault_public_network_access" {
  description = "Keep the vault's public endpoint on. Terraform writes keys and secrets through it, so turn it off only if Terraform runs inside the VNet."
  type        = bool
  default     = true
}

variable "key_vault_allowed_ips" {
  description = "Public IPs or CIDRs allowed to reach the vault (your Terraform runner). Empty with public access on means allow all (still RBAC-protected)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------- compute

variable "acr_sku" {
  description = "Container registry SKU: Basic, Standard or Premium."
  type        = string
  default     = "Standard"
}

variable "aca_zone_redundant" {
  description = "Spread the Container Apps environment across zones. Can only be set at creation."
  type        = bool
  default     = true
}

variable "web_min_replicas" {
  description = "Minimum web replicas."
  type        = number
  default     = 2
}

variable "web_max_replicas" {
  description = "Maximum web replicas."
  type        = number
  default     = 6
}

variable "worker_min_replicas" {
  description = "Minimum worker replicas. Keep at 1 or more so schedules run."
  type        = number
  default     = 1
}

variable "worker_max_replicas" {
  description = "Maximum worker replicas (scaled on the job queue)."
  type        = number
  default     = 10
}

variable "otel_collector_image" {
  description = "OpenTelemetry collector (contrib) image for the sidecars."
  type        = string
  default     = "otel/opentelemetry-collector-contrib:0.111.0"
}

variable "log_retention_days" {
  description = "Log Analytics retention in days."
  type        = number
  default     = 90
}

# ---------------------------------------------------------------- alerts

variable "alert_email" {
  description = "Email for the alert action group. Empty means the action group has no receivers."
  type        = string
  default     = ""
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
  description = "Branch trusted by a federated credential."
  type        = string
  default     = "main"
}

variable "github_environment" {
  description = "GitHub environment the deploy workflow runs in; it gets its own federated credential."
  type        = string
  default     = "production"
}
