# ================================================================ registry

resource "azurerm_container_registry" "main" {
  name                          = local.registry_name
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  sku                           = var.acr_sku
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true # GitHub-hosted runners push over the internet with Entra ID tokens
  tags                          = local.tags
}

# ================================================================ Container Apps environment

resource "azurerm_container_app_environment" "main" {
  name                               = "${local.name}-env"
  resource_group_name                = azurerm_resource_group.main.name
  location                           = azurerm_resource_group.main.location
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id           = azurerm_subnet.aca.id
  infrastructure_resource_group_name = "${local.name}-aca-infra-rg"
  internal_load_balancer_enabled     = false
  zone_redundancy_enabled            = var.aca_zone_redundant

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = local.tags
}

# ================================================================ shared app settings

locals {
  image = "${azurerm_container_registry.main.login_server}/${var.image_repository}:${var.image_tag}"

  default_url = "https://${local.web_app_name}.${azurerm_container_app_environment.main.default_domain}"
  public_url  = var.public_url != "" ? var.public_url : (var.custom_domain != "" ? "https://${var.custom_domain}" : local.default_url)

  # Runtime contract: docs/cloud/configuration.md
  base_env = merge(
    {
      PUBLIC_URL                = local.public_url
      DATABASE_SSL              = "require"
      STORAGE_BACKEND           = "azure"
      STORAGE_AZURE_ACCOUNT_URL = trimsuffix(azurerm_storage_account.evidence.primary_blob_endpoint, "/")
      STORAGE_AZURE_CONTAINER   = azurerm_storage_container.evidence.name
      SIGNER                    = "azure-kv"
      SIGNER_AZURE_KEY_ID       = azurerm_key_vault_key.signing.versionless_id
      AZURE_CLIENT_ID           = azurerm_user_assigned_identity.app.client_id
      OTEL_RESOURCE_ATTRIBUTES  = "deployment.environment=${var.environment},cloud.provider=azure"
      SEED_DEMO_DATA            = "false"
      LOG_LEVEL                 = "info"
    },
    var.extra_environment,
  )

  # Evidence connectors (docs/connectors.md). Web validates source settings, the worker syncs.
  connector_env = merge(
    { CONNECTOR_SECRET_PREFIXES = "azure-kv://${azurerm_key_vault.connectors.name}/" },
    var.connector_allowed_hosts != "" ? { CONNECTOR_ALLOWED_HOSTS = var.connector_allowed_hosts } : {},
  )

  role_env = {
    web = merge(local.connector_env, {
      OTEL_SERVICE_NAME           = "aerotrace-web"
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
    })
    worker = merge(local.connector_env, {
      OTEL_SERVICE_NAME           = "aerotrace-worker"
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
      WORKER_METRICS_PORT         = "9464"
      WORKER_SHUTDOWN_GRACE_MS    = "50000"
    })
    # The migrate job has no collector sidecar (a sidecar that never exits would keep the job
    # execution running), so OpenTelemetry stays off for it.
    migrate = {
      ADMIN_EMAIL = var.admin_email
      ADMIN_NAME  = var.admin_name
    }
  }

  role_secrets = {
    web     = ["DATABASE_URL", "SESSION_SECRET"]
    worker  = ["DATABASE_URL", "SESSION_SECRET"]
    migrate = ["DATABASE_URL", "SESSION_SECRET", "ADMIN_PASSWORD"]
  }

  # Plain environment per role, including *_REF entries in "ref" mode.
  plain_env = {
    for role, names in local.role_secrets : role => merge(
      local.base_env,
      local.role_env[role],
      { for n in names : "${n}_REF" => "azure-kv://${azurerm_key_vault.main.name}/${local.app_secret_names[n]}" if var.secret_delivery == "ref" },
    )
  }

  # Environment variables backed by Container Apps secrets in "platform" mode: NAME -> secret name.
  secret_env = {
    for role, names in local.role_secrets : role => {
      for n in names : n => local.app_secret_names[n] if var.secret_delivery == "platform"
    }
  }

  # Container Apps secrets per role, each a Key Vault reference resolved with the app identity.
  aca_secrets = {
    web     = concat(values(local.secret_env["web"]), ["appinsights-connection-string"])
    worker  = concat(values(local.secret_env["worker"]), ["appinsights-connection-string", "worker-scaler-connection"])
    migrate = values(local.secret_env["migrate"])
  }

  collector_config = file("${path.module}/../../otel/collector-azure.yaml")
}

# ================================================================ web

resource "azurerm_container_app" "web" {
  name                         = local.web_app_name
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = toset(local.aca_secrets["web"])
    content {
      name                = secret.value
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.value].versionless_id
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 3000
    transport                  = "http"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }

    dynamic "ip_security_restriction" {
      for_each = contains(var.allowed_cidrs, "0.0.0.0/0") ? [] : var.allowed_cidrs
      content {
        name             = "allow-${replace(ip_security_restriction.value, "/[./]/", "-")}"
        action           = "Allow"
        ip_address_range = ip_security_restriction.value
      }
    }
  }

  template {
    min_replicas = var.web_min_replicas
    max_replicas = var.web_max_replicas

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }

    container {
      name   = "app"
      image  = local.image
      args   = ["web"]
      cpu    = 1.0
      memory = "2Gi"

      dynamic "env" {
        for_each = local.plain_env["web"]
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env["web"]
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 10
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/health"
        interval_seconds        = 20
        timeout                 = 3
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 3000
        path                    = "/api/ready"
        interval_seconds        = 10
        timeout                 = 3
        failure_count_threshold = 3
      }

      volume_mounts {
        name = "tmp"
        path = "/tmp"
      }
    }

    container {
      name   = "otel-collector"
      image  = var.otel_collector_image
      args   = ["--config=env:OTEL_CONFIG"]
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "OTEL_CONFIG"
        value = local.collector_config
      }

      env {
        name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        secret_name = "appinsights-connection-string"
      }
    }

    volume {
      name         = "tmp"
      storage_type = "EmptyDir"
    }
  }

  tags = local.tags

  lifecycle {
    # Releases are rolled by .github/workflows/deploy-azure.yml.
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [time_sleep.app_rbac]
}

# Optional custom domain. Create the DNS records first (TXT asuid.<host> and CNAME), then bind a
# managed certificate with `az containerapp hostname bind` (see docs/cloud/azure.md).
resource "azurerm_container_app_custom_domain" "web" {
  count = var.custom_domain == "" ? 0 : 1

  name             = var.custom_domain
  container_app_id = azurerm_container_app.web.id

  lifecycle {
    # The managed certificate is bound outside Terraform.
    ignore_changes = [certificate_binding_type, container_app_environment_certificate_id]
  }
}

# ================================================================ worker

resource "azurerm_container_app" "worker" {
  name                         = local.worker_app_name
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = toset(local.aca_secrets["worker"])
    content {
      name                = secret.value
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.value].versionless_id
    }
  }

  template {
    min_replicas                     = var.worker_min_replicas
    max_replicas                     = var.worker_max_replicas
    termination_grace_period_seconds = 60

    # Scale on the queue itself: jobs ready to run right now (same query as deploy/k8s/keda-scaledobject.yaml).
    custom_scale_rule {
      name             = "job-queue"
      custom_rule_type = "postgresql"
      metadata = {
        query                      = "SELECT count(*) FROM jobs WHERE status='queued' AND run_after <= now()"
        targetQueryValue           = "4"
        activationTargetQueryValue = "0"
      }

      authentication {
        secret_name       = "worker-scaler-connection"
        trigger_parameter = "connection"
      }
    }

    container {
      name   = "app"
      image  = local.image
      args   = ["worker"]
      cpu    = 1.75
      memory = "3.5Gi"

      dynamic "env" {
        for_each = local.plain_env["worker"]
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env["worker"]
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 9464
        path                    = "/healthz"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 10
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 9464
        path                    = "/healthz"
        interval_seconds        = 30
        timeout                 = 3
        failure_count_threshold = 4
      }

      volume_mounts {
        name = "tmp"
        path = "/tmp"
      }
    }

    container {
      name   = "otel-collector"
      image  = var.otel_collector_image
      args   = ["--config=env:OTEL_CONFIG"]
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "OTEL_CONFIG"
        value = local.collector_config
      }

      env {
        name        = "APPLICATIONINSIGHTS_CONNECTION_STRING"
        secret_name = "appinsights-connection-string"
      }
    }

    volume {
      name         = "tmp"
      storage_type = "EmptyDir"
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [time_sleep.app_rbac]
}

# ================================================================ migrate job

resource "azurerm_container_app_job" "migrate" {
  name                         = local.migrate_job_name
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"

  replica_timeout_in_seconds = 1800
  # Migrations take an advisory lock and are safe to re-run.
  replica_retry_limit = 1

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = toset(local.aca_secrets["migrate"])
    content {
      name                = secret.value
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.app[secret.value].versionless_id
    }
  }

  template {
    container {
      name   = "app"
      image  = local.image
      args   = ["migrate"]
      cpu    = 0.5
      memory = "1Gi"

      dynamic "env" {
        for_each = local.plain_env["migrate"]
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_env["migrate"]
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      volume_mounts {
        name = "tmp"
        path = "/tmp"
      }
    }

    volume {
      name         = "tmp"
      storage_type = "EmptyDir"
    }
  }

  tags = local.tags

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [time_sleep.app_rbac]
}
