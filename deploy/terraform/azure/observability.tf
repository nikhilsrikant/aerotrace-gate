# ================================================================ workspace and App Insights

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.name}-logs"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

resource "azurerm_application_insights" "main" {
  name                = "${local.name}-appi"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  workspace_id        = azurerm_log_analytics_workspace.main.id
  application_type    = "web"
  tags                = local.tags
}

# Key Vault audit log: every sign operation and secret read lands in Log Analytics.
resource "azurerm_monitor_diagnostic_setting" "key_vault" {
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_key_vault.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category_group = "audit"
  }

  metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "to-log-analytics"
  target_resource_id         = azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }

  metric {
    category = "AllMetrics"
  }
}

# ================================================================ action group

resource "azurerm_monitor_action_group" "main" {
  name                = "${local.name}-alerts"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = substr(replace(local.name, "-", ""), 0, 12)

  dynamic "email_receiver" {
    for_each = var.alert_email == "" ? [] : [var.alert_email]
    content {
      name                    = "oncall"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }

  tags = local.tags
}

locals {
  container_apps = {
    web    = azurerm_container_app.web.id
    worker = azurerm_container_app.worker.id
  }

  min_replicas = {
    web    = var.web_min_replicas
    worker = var.worker_min_replicas
  }
}

# ================================================================ Container Apps

resource "azurerm_monitor_metric_alert" "restarts" {
  for_each = local.container_apps

  name                = "${local.name}-${each.key}-restarts"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value]
  description         = "More than 3 container restarts in 15 minutes (${each.key})."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "RestartCount"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 3
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = local.tags
}

resource "azurerm_monitor_metric_alert" "no_replicas" {
  for_each = { for k, v in local.container_apps : k => v if local.min_replicas[k] > 0 }

  name                = "${local.name}-${each.key}-no-replicas"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value]
  description         = "No running ${each.key} replica for 15 minutes."
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Replicas"
    aggregation      = "Maximum"
    operator         = "LessThan"
    threshold        = 1
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = local.tags
}

# ================================================================ PostgreSQL

resource "azurerm_monitor_metric_alert" "postgres_cpu" {
  name                = "${local.name}-postgres-cpu"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Database CPU above 80% for 15 minutes."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = local.tags
}

resource "azurerm_monitor_metric_alert" "postgres_storage" {
  name                = "${local.name}-postgres-storage"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Database storage above 85% used. Auto-grow is on, so check that it is working."
  severity            = 2
  frequency           = "PT15M"
  window_size         = "PT30M"

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "storage_percent"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    threshold        = 85
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = local.tags
}

# ================================================================ App Insights queries

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "request_failure_rate" {
  name                 = "${local.name}-request-failure-rate"
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_resource_group.main.location
  scopes               = [azurerm_application_insights.main.id]
  description          = "More than 5% of web requests failed over 15 minutes."
  severity             = 2
  evaluation_frequency = "PT5M"
  window_duration      = "PT15M"
  enabled              = true

  criteria {
    query                   = <<-KQL
      requests
      | where cloud_RoleName == "aerotrace-web"
      | summarize total = count(), failed = countif(success == false)
      | extend rate = iff(total == 0, 0.0, todouble(failed) * 100.0 / total)
      | project rate
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "rate"
    operator                = "GreaterThan"
    threshold               = 5

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.main.id]
  }

  tags = local.tags
}

resource "azurerm_monitor_scheduled_query_rules_alert_v2" "approval_age" {
  name                 = "${local.name}-approval-oldest-age"
  resource_group_name  = azurerm_resource_group.main.name
  location             = azurerm_resource_group.main.location
  scopes               = [azurerm_application_insights.main.id]
  description          = "An audit has waited more than 2 days for human approval."
  severity             = 3
  evaluation_frequency = "PT15M"
  window_duration      = "PT30M"
  enabled              = true
  # The metric does not exist until the app has reported it once.
  skip_query_validation = true

  criteria {
    query                   = <<-KQL
      customMetrics
      | where name == "aerotrace.approvals.oldest_age_seconds"
      | summarize age = max(value)
    KQL
    time_aggregation_method = "Maximum"
    metric_measure_column   = "age"
    operator                = "GreaterThan"
    threshold               = 172800

    failing_periods {
      minimum_failing_periods_to_trigger_alert = 1
      number_of_evaluation_periods             = 1
    }
  }

  action {
    action_groups = [azurerm_monitor_action_group.main.id]
  }

  tags = local.tags
}
