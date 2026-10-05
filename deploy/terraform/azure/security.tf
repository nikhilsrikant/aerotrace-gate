# ================================================================ Key Vault

resource "azurerm_key_vault" "main" {
  name                = local.key_vault_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = var.key_vault_sku

  # Newer 4.x releases also accept rbac_authorization_enabled; this spelling works across 4.x.
  enable_rbac_authorization     = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = var.key_vault_public_network_access

  network_acls {
    bypass         = "AzureServices"
    default_action = length(var.key_vault_allowed_ips) > 0 ? "Deny" : "Allow"
    ip_rules       = var.key_vault_allowed_ips
  }

  tags = local.tags
}

resource "azurerm_management_lock" "key_vault" {
  count = var.deletion_protection ? 1 : 0

  name       = "${local.name}-kv-lock"
  scope      = azurerm_key_vault.main.id
  lock_level = "CanNotDelete"
  notes      = "Holds the decision-signing key. Remove deliberately before teardown."
}

# Whoever runs Terraform needs data-plane rights to create the key and secrets.
resource "azurerm_role_assignment" "terraform_kv_admin" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Role assignments take a short while to reach Key Vault.
resource "time_sleep" "kv_rbac" {
  create_duration = "60s"
  depends_on      = [azurerm_role_assignment.terraform_kv_admin]
}

# ---------------------------------------------------------------- connector vault

# Evidence connector tokens only (docs/connectors.md). A separate vault keeps them apart from the
# app's own secrets, so the app identity can read the whole vault and still not reach the
# database password. Operators add the secrets; Terraform creates none.
resource "azurerm_key_vault" "connectors" {
  name                = local.connector_kv_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard" # secrets only; premium matters for HSM keys

  enable_rbac_authorization     = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = var.key_vault_public_network_access

  network_acls {
    bypass         = "AzureServices"
    default_action = length(var.key_vault_allowed_ips) > 0 ? "Deny" : "Allow"
    ip_rules       = var.key_vault_allowed_ips
  }

  tags = local.tags
}

# Whoever runs Terraform can add and rotate connector tokens (az keyvault secret set).
resource "azurerm_role_assignment" "terraform_connector_kv_secrets" {
  scope                = azurerm_key_vault.connectors.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# ---------------------------------------------------------------- signing key (ES256, P-256)

locals {
  signing_key_type = var.hsm && var.key_vault_sku == "premium" ? "EC-HSM" : "EC"
}

resource "azurerm_key_vault_key" "signing" {
  name         = "aerotrace-signing"
  key_vault_id = azurerm_key_vault.main.id
  key_type     = local.signing_key_type
  curve        = "P-256"
  key_opts     = ["sign", "verify"]

  # A new version is created on rotation. SIGNER_AZURE_KEY_ID is versionless, so the app signs
  # with the newest version and keeps the older public keys it has already recorded.
  dynamic "rotation_policy" {
    for_each = var.signing_key_rotation_days > 0 ? [1] : []
    content {
      automatic {
        time_after_creation = "P${var.signing_key_rotation_days}D"
      }
    }
  }

  tags       = local.tags
  depends_on = [time_sleep.kv_rbac]
}

# ---------------------------------------------------------------- secrets

resource "random_password" "session" {
  length  = 64
  special = false
}

resource "random_password" "admin" {
  length           = 24
  special          = true
  override_special = "!#%*-_=+"
  min_lower        = 2
  min_upper        = 2
  min_numeric      = 2
  min_special      = 2
}

locals {
  kv_secret_names = [
    "postgres-admin-password",
    "database-url",
    "session-secret",
    "admin-password",
    "worker-scaler-connection",
    "appinsights-connection-string",
  ]

  kv_secret_values = {
    "postgres-admin-password"       = random_password.db.result
    "database-url"                  = local.database_url
    "session-secret"                = random_password.session.result
    "admin-password"                = random_password.admin.result
    "worker-scaler-connection"      = local.scaler_connection
    "appinsights-connection-string" = azurerm_application_insights.main.connection_string
  }

  # App environment variable -> Key Vault secret name.
  app_secret_names = {
    DATABASE_URL   = "database-url"
    SESSION_SECRET = "session-secret"
    ADMIN_PASSWORD = "admin-password"
  }
}

resource "azurerm_key_vault_secret" "app" {
  for_each = toset(local.kv_secret_names)

  name         = each.key
  value        = local.kv_secret_values[each.key]
  key_vault_id = azurerm_key_vault.main.id
  content_type = "text/plain"
  tags         = local.tags

  depends_on = [time_sleep.kv_rbac]
}

# ================================================================ app identity

resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name}-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags
}

# Sign and read the public key. Scoped to the one key rather than the whole vault.
resource "azurerm_role_assignment" "app_crypto" {
  scope                = azurerm_key_vault_key.signing.resource_versionless_id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# Read only the secrets the apps use (not the Postgres admin password).
resource "azurerm_role_assignment" "app_secrets" {
  for_each = toset(["database-url", "session-secret", "admin-password", "worker-scaler-connection", "appinsights-connection-string"])

  scope                = azurerm_key_vault_secret.app[each.key].resource_versionless_id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# Read any secret in the connector vault, which holds nothing but connector tokens.
resource "azurerm_role_assignment" "app_connector_secrets" {
  scope                = azurerm_key_vault.connectors.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_blob" {
  scope                = azurerm_storage_account.evidence.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "app_acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# Container Apps checks registry and Key Vault access when a revision is created.
resource "time_sleep" "app_rbac" {
  create_duration = "60s"
  depends_on = [
    azurerm_role_assignment.app_crypto,
    azurerm_role_assignment.app_secrets,
    azurerm_role_assignment.app_connector_secrets,
    azurerm_role_assignment.app_blob,
    azurerm_role_assignment.app_acr_pull,
  ]
}

# ================================================================ GitHub OIDC deploy identity

data "azuread_client_config" "current" {}

resource "azuread_application" "deploy" {
  display_name     = "${local.name}-github-deploy"
  owners           = [data.azuread_client_config.current.object_id]
  sign_in_audience = "AzureADMyOrg"
}

resource "azuread_service_principal" "deploy" {
  client_id = azuread_application.deploy.client_id
  owners    = [data.azuread_client_config.current.object_id]
}

# Jobs that use a GitHub environment present an environment subject; the branch subject covers
# jobs without one. Restrict the environment's deployment branches to main and v* tags in GitHub.
resource "azuread_application_federated_identity_credential" "github" {
  for_each = {
    environment = "repo:${var.github_repo}:environment:${var.github_environment}"
    branch      = "repo:${var.github_repo}:ref:refs/heads/${var.github_branch}"
  }

  application_id = azuread_application.deploy.id
  display_name   = "github-${each.key}"
  description    = "GitHub Actions deploy for ${var.github_repo} (${each.key})"
  audiences      = ["api://AzureADTokenExchange"]
  issuer         = "https://token.actions.githubusercontent.com"
  subject        = each.value
}

resource "azurerm_role_assignment" "deploy_acr_push" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = azuread_service_principal.deploy.object_id
}

# Broad on purpose so the workflow works out of the box. It only needs to update the two apps and
# start the job: a custom role with Microsoft.App/containerApps/write, Microsoft.App/jobs/start/action,
# Microsoft.App/jobs/read, Microsoft.App/jobs/write and */read on the resource group is enough.
resource "azurerm_role_assignment" "deploy_contributor" {
  scope                = azurerm_resource_group.main.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.deploy.object_id
}
