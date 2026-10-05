# ================================================================ Artifact Registry

resource "google_artifact_registry_repository" "main" {
  location      = var.region
  repository_id = local.name
  description   = "AeroTrace Gate images (${var.environment})"
  format        = "DOCKER"

  docker_config {
    immutable_tags = true
  }

  labels = local.labels

  depends_on = [google_project_service.enabled]
}

# ================================================================ shared settings

locals {
  registry_path = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.main.repository_id}"
  image         = "${local.registry_path}/${var.image_name}:${var.image_tag}"

  # Runtime contract: docs/cloud/configuration.md
  base_env = merge(
    {
      PUBLIC_URL               = local.public_url
      DATABASE_SSL             = "require"
      STORAGE_BACKEND          = "gcs"
      STORAGE_GCS_BUCKET       = google_storage_bucket.evidence.name
      SIGNER                   = "gcp-kms"
      SIGNER_GCP_KMS_KEY       = local.signing_key_version
      OTEL_RESOURCE_ATTRIBUTES = "deployment.environment=${var.environment},cloud.provider=gcp"
      SEED_DEMO_DATA           = "false"
      LOG_LEVEL                = "info"
    },
    var.extra_environment,
  )

  # Evidence connectors (docs/connectors.md). Web validates source settings, the worker syncs.
  connector_env = merge(
    { CONNECTOR_SECRET_PREFIXES = local.connector_secret_prefix },
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
      WORKER_SHUTDOWN_GRACE_MS    = "8000" # Cloud Run gives 10 s after SIGTERM
    })
    # No collector sidecar on the job (it would never exit), so OpenTelemetry is off for migrate.
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

  plain_env = {
    for role, names in local.role_secrets : role => merge(
      local.base_env,
      local.role_env[role],
      {
        for n in names :
        "${n}_REF" => "gcp-sm://projects/${var.project_id}/secrets/${google_secret_manager_secret.app[local.app_secret_names[n]].secret_id}/versions/latest"
        if var.secret_delivery == "ref"
      },
    )
  }

  # "platform" mode: NAME -> Secret Manager secret id, injected by Cloud Run.
  secret_env = {
    for role, names in local.role_secrets : role => {
      for n in names : n => google_secret_manager_secret.app[local.app_secret_names[n]].secret_id
      if var.secret_delivery == "platform"
    }
  }

  collector_config = file("${path.module}/../../otel/collector-gcp.yaml")
}

# ================================================================ web

resource "google_cloud_run_v2_service" "web" {
  name                = local.web_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    service_account                  = google_service_account.app.email
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    timeout                          = "300s"
    max_instance_request_concurrency = 80

    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = var.web_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
    }

    containers {
      name       = "app"
      image      = local.image
      args       = ["web"]
      depends_on = ["otel-collector"]

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = var.web_cpu
          memory = var.web_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

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
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 30
        http_get {
          path = "/api/health"
          port = 3000
        }
      }

      liveness_probe {
        period_seconds    = 20
        timeout_seconds   = 3
        failure_threshold = 3
        http_get {
          path = "/api/health"
          port = 3000
        }
      }

      volume_mounts {
        name       = "tmp"
        mount_path = "/tmp"
      }
    }

    containers {
      name  = "otel-collector"
      image = var.otel_collector_image
      args  = ["--config=env:OTEL_CONFIG"]

      resources {
        limits = {
          cpu    = var.collector_cpu
          memory = var.collector_memory
        }
        cpu_idle = true
      }

      env {
        name  = "OTEL_CONFIG"
        value = local.collector_config
      }

      # The app container waits for this probe (depends_on above).
      startup_probe {
        period_seconds    = 2
        timeout_seconds   = 1
        failure_threshold = 30
        http_get {
          path = "/"
          port = 13133
        }
      }
    }

    volumes {
      name = "tmp"
      empty_dir {
        medium     = "MEMORY"
        size_limit = "512Mi"
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    # Releases are rolled by .github/workflows/deploy-gcp.yml.
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_project_iam_member.app,
    google_secret_manager_secret_iam_member.app,
    google_kms_crypto_key_iam_member.app_sign,
    google_storage_bucket_iam_member.app,
    google_secret_manager_secret_version.app,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  count = var.allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = google_cloud_run_v2_service.web.location
  name     = google_cloud_run_v2_service.web.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ================================================================ worker

resource "google_cloud_run_v2_service" "worker" {
  name                = local.worker_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    service_account       = google_service_account.app.email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.main.id
      }
    }

    containers {
      name       = "app"
      image      = local.image
      args       = ["worker"]
      depends_on = ["otel-collector"]

      # Cloud Run needs a listening port; the worker's metrics/health server is it.
      ports {
        container_port = 9464
      }

      resources {
        limits = {
          cpu    = var.worker_cpu
          memory = var.worker_memory
        }
        # Instance-based billing: CPU stays on between requests so jobs keep running.
        cpu_idle = false
      }

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
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 30
        http_get {
          path = "/healthz"
          port = 9464
        }
      }

      liveness_probe {
        period_seconds    = 30
        timeout_seconds   = 3
        failure_threshold = 4
        http_get {
          path = "/healthz"
          port = 9464
        }
      }

      volume_mounts {
        name       = "tmp"
        mount_path = "/tmp"
      }
    }

    containers {
      name  = "otel-collector"
      image = var.otel_collector_image
      args  = ["--config=env:OTEL_CONFIG"]

      resources {
        limits = {
          cpu    = var.collector_cpu
          memory = var.collector_memory
        }
        cpu_idle = false
      }

      env {
        name  = "OTEL_CONFIG"
        value = local.collector_config
      }

      startup_probe {
        period_seconds    = 2
        timeout_seconds   = 1
        failure_threshold = 30
        http_get {
          path = "/"
          port = 13133
        }
      }
    }

    volumes {
      name = "tmp"
      empty_dir {
        medium     = "MEMORY"
        size_limit = "1Gi"
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_project_iam_member.app,
    google_secret_manager_secret_iam_member.app,
    google_kms_crypto_key_iam_member.app_sign,
    google_storage_bucket_iam_member.app,
    google_secret_manager_secret_version.app,
  ]
}

# ================================================================ migrate job

resource "google_cloud_run_v2_job" "migrate" {
  name                = local.migrate_job_name
  location            = var.region
  deletion_protection = var.deletion_protection
  labels              = local.labels

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account       = google_service_account.app.email
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
      timeout               = "1800s"
      # Migrations take an advisory lock and are safe to re-run.
      max_retries = 1

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.main.id
        }
      }

      containers {
        name  = "app"
        image = local.image
        args  = ["migrate"]

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

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
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }

        volume_mounts {
          name       = "tmp"
          mount_path = "/tmp"
        }
      }

      volumes {
        name = "tmp"
        empty_dir {
          medium     = "MEMORY"
          size_limit = "256Mi"
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_project_iam_member.app,
    google_secret_manager_secret_iam_member.app,
    google_kms_crypto_key_iam_member.app_sign,
    google_storage_bucket_iam_member.app,
    google_secret_manager_secret_version.app,
  ]
}
