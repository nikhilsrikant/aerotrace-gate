resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email == "" ? 0 : 1

  display_name = "AeroTrace ${var.environment} on-call"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
  user_labels = local.labels

  depends_on = [google_project_service.enabled]
}

locals {
  notification_channels = google_monitoring_notification_channel.email[*].id
  sql_database_id       = "${var.project_id}:${google_sql_database_instance.main.name}"
  web_requests_filter   = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.web.name}\" AND metric.type = \"run.googleapis.com/request_count\""
}

# ---------------------------------------------------------------- Cloud Run

resource "google_monitoring_alert_policy" "web_5xx_ratio" {
  display_name          = "${local.name}: web 5xx ratio above 5%"
  combiner              = "OR"
  notification_channels = local.notification_channels
  user_labels           = local.labels

  conditions {
    display_name = "5xx / all requests > 5% for 5 minutes"

    condition_threshold {
      filter             = "${local.web_requests_filter} AND metric.labels.response_code_class = \"5xx\""
      denominator_filter = local.web_requests_filter
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.05
      duration           = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      denominator_aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "More than 5% of requests to ${google_cloud_run_v2_service.web.name} returned 5xx. Check Cloud Run logs and /api/ready (database reachability)."
  }
}

# ---------------------------------------------------------------- Cloud SQL

resource "google_monitoring_alert_policy" "sql_cpu" {
  display_name          = "${local.name}: Cloud SQL CPU above 80%"
  combiner              = "OR"
  notification_channels = local.notification_channels
  user_labels           = local.labels

  conditions {
    display_name = "CPU utilisation > 80% for 15 minutes"

    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.sql_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }
}

resource "google_monitoring_alert_policy" "sql_disk" {
  display_name          = "${local.name}: Cloud SQL disk above 85%"
  combiner              = "OR"
  notification_channels = local.notification_channels
  user_labels           = local.labels

  conditions {
    display_name = "Disk utilisation > 85%"

    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.sql_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/disk/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "Auto-resize is on, so this usually means it is growing fast. Check the jobs and audit_log tables."
  }
}

# ---------------------------------------------------------------- app metrics (via the collector)

resource "google_monitoring_alert_policy" "approval_age" {
  count = var.enable_app_metric_alerts ? 1 : 0

  display_name          = "${local.name}: approval waiting more than 2 days"
  combiner              = "OR"
  notification_channels = local.notification_channels
  user_labels           = local.labels

  conditions {
    display_name = "Oldest pending approval > 172800 s"

    condition_threshold {
      filter          = "metric.type = \"custom.googleapis.com/aerotrace/aerotrace.approvals.oldest_age_seconds\""
      comparison      = "COMPARISON_GT"
      threshold_value = 172800
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }

  documentation {
    mime_type = "text/markdown"
    content   = "An audit has waited more than two days for a human approval decision. Check the approvals queue and whether approvers are reachable."
  }
}
