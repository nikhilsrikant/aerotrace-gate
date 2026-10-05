resource "random_password" "db" {
  length           = 40
  special          = true
  override_special = "-_~"
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                = local.postgres_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  version             = "16"
  sku_name            = var.db_sku
  zone                = var.db_zone

  # Private access: the server lives in the delegated subnet and has no public endpoint.
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false

  administrator_login    = "aerotrace"
  administrator_password = random_password.db.result

  authentication {
    password_auth_enabled         = true
    active_directory_auth_enabled = false
  }

  storage_mb        = var.db_storage_mb
  auto_grow_enabled = true

  backup_retention_days        = var.db_backup_retention_days
  geo_redundant_backup_enabled = var.db_geo_redundant_backup

  dynamic "high_availability" {
    for_each = var.db_zone_redundant_ha ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = var.db_standby_zone
    }
  }

  maintenance_window {
    day_of_week  = 0
    start_hour   = 4
    start_minute = 30
  }

  tags = local.tags

  lifecycle {
    # Azure swaps zones on failover; do not fight it.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

# TLS is required by default on Flexible Server; pin it so nobody turns it off by accident.
resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

resource "azurerm_postgresql_flexible_server_configuration" "min_tls" {
  name      = "ssl_min_protocol_version"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "TLSv1.2"
}

resource "azurerm_postgresql_flexible_server_database" "aerotrace" {
  name      = "aerotrace"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# Flexible Server has no deletion-protection flag; a management lock does the job.
resource "azurerm_management_lock" "postgres" {
  count = var.deletion_protection ? 1 : 0

  name       = "${local.name}-postgres-lock"
  scope      = azurerm_postgresql_flexible_server.main.id
  lock_level = "CanNotDelete"
  notes      = "AeroTrace database. Remove deliberately before teardown."
}

locals {
  db_host = azurerm_postgresql_flexible_server.main.fqdn

  # DATABASE_SSL=require is set separately, so the app URL stays plain.
  database_url = "postgres://aerotrace:${random_password.db.result}@${local.db_host}:5432/aerotrace"

  # The KEDA postgresql scaler connects on its own and needs sslmode in the URL.
  scaler_connection = "postgresql://aerotrace:${random_password.db.result}@${local.db_host}:5432/aerotrace?sslmode=require"
}
