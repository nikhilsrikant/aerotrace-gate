# AeroTrace Gate on Azure: Container Apps (web, worker, migrate job) on a VNet, PostgreSQL
# Flexible Server with private access, Blob Storage evidence, Key Vault signing key and secrets,
# Log Analytics + Application Insights via an OpenTelemetry collector sidecar.
#
# Files:
#   network.tf        VNet, subnets, private DNS zones, private endpoints
#   database.tf       PostgreSQL Flexible Server
#   security.tf       Key Vault, signing key, secrets, managed identity, roles, GitHub OIDC
#   compute.tf        registry, Container Apps environment, web, worker, migrate job
#   observability.tf  Log Analytics, Application Insights, alerts
#   main.tf           (this file) locals, resource group, evidence storage

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

locals {
  name   = "${var.name_prefix}-${var.environment}"
  suffix = random_string.suffix.result

  # Globally unique names with tight character rules.
  compact_prefix    = substr(replace(var.name_prefix, "-", ""), 0, 11)
  key_vault_name    = "${substr(var.name_prefix, 0, 9)}-${substr(var.environment, 0, 4)}-${local.suffix}"
  connector_kv_name = "${substr(var.name_prefix, 0, 9)}-${substr(var.environment, 0, 4)}-cn${local.suffix}"
  storage_name      = "${local.compact_prefix}${substr(var.environment, 0, 4)}${local.suffix}"
  registry_name     = "${local.compact_prefix}${var.environment}${local.suffix}"
  postgres_name     = "${local.name}-pg-${local.suffix}"
  web_app_name      = "${local.name}-web"
  worker_app_name   = "${local.name}-worker"
  migrate_job_name  = "${local.name}-migrate"
  evidence_container = "evidence"

  tags = merge({
    application = "aerotrace-gate"
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)
}

resource "azurerm_resource_group" "main" {
  name     = "${local.name}-rg"
  location = var.location
  tags     = local.tags
}

# ---------------------------------------------------------------- evidence storage

resource "azurerm_storage_account" "evidence" {
  name                = local.storage_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = var.storage_replication
  access_tier              = "Hot"

  min_tls_version                   = "TLS1_2"
  https_traffic_only_enabled        = true
  allow_nested_items_to_be_public   = false
  shared_access_key_enabled         = false
  default_to_oauth_authentication   = true
  infrastructure_encryption_enabled = true
  cross_tenant_replication_enabled  = false
  public_network_access_enabled     = var.storage_public_network_access

  blob_properties {
    versioning_enabled  = true
    change_feed_enabled = true

    delete_retention_policy {
      days = 30
    }

    container_delete_retention_policy {
      days = 30
    }
  }

  tags = local.tags
}

resource "azurerm_storage_container" "evidence" {
  name                  = local.evidence_container
  storage_account_id    = azurerm_storage_account.evidence.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "evidence" {
  count = var.evidence_cold_after_days > 0 ? 1 : 0

  storage_account_id = azurerm_storage_account.evidence.id

  rule {
    name    = "evidence-to-cold"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${local.evidence_container}/"]
    }

    actions {
      base_blob {
        tier_to_cold_after_days_since_modification_greater_than = var.evidence_cold_after_days
      }

      version {
        tier_to_cold_after_days_since_creation = var.evidence_cold_after_days
      }
    }
  }
}

resource "azurerm_management_lock" "storage" {
  count = var.deletion_protection ? 1 : 0

  name       = "${local.name}-evidence-lock"
  scope      = azurerm_storage_account.evidence.id
  lock_level = "CanNotDelete"
  notes      = "Audit evidence. Remove deliberately before teardown."
}
