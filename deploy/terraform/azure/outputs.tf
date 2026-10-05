output "web_url" {
  description = "URL the app is configured for (PUBLIC_URL)."
  value       = local.public_url
}

output "web_fqdn" {
  description = "Default Container Apps hostname of the web app. Point a custom domain's CNAME here."
  value       = azurerm_container_app.web.ingress[0].fqdn
}

output "custom_domain_verification_id" {
  description = "Value for the TXT record asuid.<custom_domain>, needed before a custom domain can be added."
  value       = azurerm_container_app.web.custom_domain_verification_id
}

output "resource_group_name" {
  description = "Resource group holding everything."
  value       = azurerm_resource_group.main.name
}

output "registry_name" {
  description = "Container registry name (for az acr login)."
  value       = azurerm_container_registry.main.name
}

output "registry_login_server" {
  description = "Container registry login server."
  value       = azurerm_container_registry.main.login_server
}

output "web_app_name" {
  description = "Container App running the web role."
  value       = azurerm_container_app.web.name
}

output "worker_app_name" {
  description = "Container App running the worker role."
  value       = azurerm_container_app.worker.name
}

output "migrate_job_name" {
  description = "Container Apps Job running migrate."
  value       = azurerm_container_app_job.migrate.name
}

output "container_app_environment_name" {
  description = "Container Apps environment (needed for az containerapp hostname bind)."
  value       = azurerm_container_app_environment.main.name
}

output "deploy_client_id" {
  description = "Client ID of the GitHub deploy application (federated credentials, no secret)."
  value       = azuread_application.deploy.client_id
}

output "tenant_id" {
  description = "Entra tenant ID."
  value       = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  description = "Subscription ID."
  value       = var.subscription_id
}

output "key_vault_name" {
  description = "Key Vault holding the signing key and secrets."
  value       = azurerm_key_vault.main.name
}

output "connector_key_vault_name" {
  description = "Key Vault for evidence connector tokens. The app identity can read every secret in it, so keep nothing else there."
  value       = azurerm_key_vault.connectors.name
}

output "connector_secret_prefix" {
  description = "Evidence connector token references must start with this (CONNECTOR_SECRET_PREFIXES)."
  value       = "azure-kv://${azurerm_key_vault.connectors.name}/"
}

output "signing_key_id" {
  description = "Versionless signing key ID (SIGNER_AZURE_KEY_ID)."
  value       = azurerm_key_vault_key.signing.versionless_id
}

output "storage_account_url" {
  description = "Blob endpoint of the evidence storage account."
  value       = trimsuffix(azurerm_storage_account.evidence.primary_blob_endpoint, "/")
}

output "app_identity_client_id" {
  description = "Client ID of the app's user-assigned managed identity (AZURE_CLIENT_ID)."
  value       = azurerm_user_assigned_identity.app.client_id
}

output "postgres_fqdn" {
  description = "Private hostname of the PostgreSQL server."
  value       = azurerm_postgresql_flexible_server.main.fqdn
}

output "github_variables" {
  description = "Repository or environment variables for .github/workflows/deploy-azure.yml."
  value = {
    AZURE_CLIENT_ID        = azuread_application.deploy.client_id
    AZURE_TENANT_ID        = data.azurerm_client_config.current.tenant_id
    AZURE_SUBSCRIPTION_ID  = var.subscription_id
    AZURE_RESOURCE_GROUP   = azurerm_resource_group.main.name
    ACR_NAME               = azurerm_container_registry.main.name
    ACR_LOGIN_SERVER       = azurerm_container_registry.main.login_server
    ACA_WEB_APP            = azurerm_container_app.web.name
    ACA_WORKER_APP         = azurerm_container_app.worker.name
    ACA_MIGRATE_JOB        = azurerm_container_app_job.migrate.name
    AEROTRACE_PUBLIC_URL   = local.public_url
  }
}
