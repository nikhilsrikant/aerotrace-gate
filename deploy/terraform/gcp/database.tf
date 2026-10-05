resource "random_password" "db" {
  length           = 40
  special          = true
  override_special = "-_~"
}

resource "google_sql_database_instance" "main" {
  name                = "${local.name}-pg-${local.suffix}"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.db_tier
    edition           = var.db_edition
    availability_type = var.db_availability_type
    disk_type         = "PD_SSD"
    disk_size         = var.db_disk_size_gb
    disk_autoresize   = true

    # Protects against deletion through any API, not only Terraform.
    deletion_protection_enabled = var.deletion_protection

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.main.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = var.db_pitr_days

      backup_retention_settings {
        retained_backups = var.db_backup_retention_count
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      record_application_tags = false
      record_client_address   = false
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "2000"
    }

    user_labels = local.labels
  }

  depends_on = [google_service_networking_connection.psa]
}

resource "google_sql_database" "aerotrace" {
  name     = "aerotrace"
  instance = google_sql_database_instance.main.name
}

# Built-in (password) user. The password goes straight into Secret Manager.
resource "google_sql_user" "aerotrace" {
  name     = "aerotrace"
  instance = google_sql_database_instance.main.name
  type     = "BUILT_IN"
  password = random_password.db.result
}

locals {
  # DATABASE_SSL=require is set separately, so the URL stays plain.
  database_url = "postgres://${google_sql_user.aerotrace.name}:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/${google_sql_database.aerotrace.name}"
}
