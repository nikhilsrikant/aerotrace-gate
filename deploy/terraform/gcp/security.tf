# ================================================================ KMS

# Key rings cannot be deleted, so the name carries a random suffix to allow re-creation.
resource "google_kms_key_ring" "main" {
  name     = "${local.name}-${local.suffix}"
  location = var.region

  depends_on = [google_project_service.enabled]
}

# Decision signing: ES256 (ECDSA P-256 / SHA-256). Version 1 is created with the key.
resource "google_kms_crypto_key" "signing" {
  name     = "aerotrace-signing"
  key_ring = google_kms_key_ring.main.id
  purpose  = "ASYMMETRIC_SIGN"

  version_template {
    algorithm        = "EC_SIGN_P256_SHA256"
    protection_level = var.kms_protection_level
  }

  # A destroyed version can be restored for 30 days.
  destroy_scheduled_duration = "2592000s"

  labels = local.labels
}

locals {
  # SIGNER_GCP_KMS_KEY names one key version. To rotate, create a new version and raise
  # var.signing_key_version (docs/cloud/gcp.md).
  signing_key_version = "${google_kms_crypto_key.signing.id}/cryptoKeyVersions/${var.signing_key_version}"
}

# ================================================================ Secret Manager

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
  secret_names = ["db-password", "database-url", "session-secret", "admin-password"]

  secret_values = {
    "db-password"    = random_password.db.result
    "database-url"   = local.database_url
    "session-secret" = random_password.session.result
    "admin-password" = random_password.admin.result
  }

  # App environment variable -> secret short name.
  app_secret_names = {
    DATABASE_URL   = "database-url"
    SESSION_SECRET = "session-secret"
    ADMIN_PASSWORD = "admin-password"
  }
}

resource "google_secret_manager_secret" "app" {
  for_each = toset(local.secret_names)

  secret_id = "${local.name}-${each.key}"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "app" {
  for_each = toset(local.secret_names)

  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = local.secret_values[each.key]
}

# ================================================================ app service account

resource "google_service_account" "app" {
  account_id   = "${local.name}-app"
  display_name = "AeroTrace Gate app (${var.environment})"

  depends_on = [google_project_service.enabled]
}

locals {
  app_sa_member = "serviceAccount:${google_service_account.app.email}"
}

resource "google_project_iam_member" "app" {
  for_each = toset([
    "roles/cloudsql.client",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
    "roles/logging.logWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = local.app_sa_member
}

# Only the secrets the app uses; the raw database password is not readable by the app.
resource "google_secret_manager_secret_iam_member" "app" {
  for_each = toset(values(local.app_secret_names))

  secret_id = google_secret_manager_secret.app[each.key].id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.app_sa_member
}

# Evidence connector tokens: secrets named <prefix>-<env>-connector-*, created by operators.
# References use the project ID (CONNECTOR_SECRET_PREFIXES) but Secret Manager resource names in
# IAM conditions use the project number.
locals {
  connector_secret_id_prefix = "${local.name}-connector-"
  connector_secret_prefix    = "gcp-sm://projects/${var.project_id}/secrets/${local.connector_secret_id_prefix}"
}

resource "google_project_iam_member" "app_connector_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = local.app_sa_member

  condition {
    title       = "connector-secrets-only"
    description = "Evidence connector tokens (${local.connector_secret_id_prefix}*)"
    expression  = "resource.name.startsWith(\"projects/${data.google_project.this.number}/secrets/${local.connector_secret_id_prefix}\")"
  }
}

resource "google_kms_crypto_key_iam_member" "app_sign" {
  for_each = toset(["roles/cloudkms.signerVerifier", "roles/cloudkms.publicKeyViewer"])

  crypto_key_id = google_kms_crypto_key.signing.id
  role          = each.value
  member        = local.app_sa_member
}

# objectAdmin includes delete; bucket versioning keeps every earlier version.
resource "google_storage_bucket_iam_member" "app" {
  bucket = google_storage_bucket.evidence.name
  role   = "roles/storage.objectAdmin"
  member = local.app_sa_member
}

# ================================================================ GitHub Workload Identity Federation

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${local.name}-gh-${local.suffix}"
  display_name              = "GitHub ${local.name}"
  description               = "GitHub Actions deploys for ${var.github_repo}"

  depends_on = [google_project_service.enabled]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Only this repository, and only main or v* tags.
  attribute_condition = "assertion.repository == '${var.github_repo}' && (assertion.ref == 'refs/heads/${var.github_branch}' || assertion.ref.startsWith('refs/tags/v'))"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "deploy" {
  account_id   = "${local.name}-deploy"
  display_name = "AeroTrace Gate GitHub deploy (${var.environment})"

  depends_on = [google_project_service.enabled]
}

resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# Project-wide because Cloud Run has no per-service grant for creating executions and revisions at
# deploy time. Narrow it to roles/run.developer plus per-service IAM if your policy requires.
resource "google_project_iam_member" "deploy_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_artifact_registry_repository_iam_member" "deploy_writer" {
  location   = google_artifact_registry_repository.main.location
  repository = google_artifact_registry_repository.main.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

# Deploying a revision that runs as the app service account requires actAs on it.
resource "google_service_account_iam_member" "deploy_act_as_app" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}
