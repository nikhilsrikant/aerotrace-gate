output "web_url" {
  description = "URL the app is configured for (PUBLIC_URL)."
  value       = local.public_url
}

output "web_run_url" {
  description = "Cloud Run URL of the web service."
  value       = google_cloud_run_v2_service.web.uri
}

output "artifact_registry_repo" {
  description = "Docker repository path; images are <this>/aerotrace-gate:<tag>."
  value       = local.registry_path
}

output "web_service_name" {
  description = "Cloud Run service running the web role."
  value       = google_cloud_run_v2_service.web.name
}

output "worker_service_name" {
  description = "Cloud Run service running the worker role."
  value       = google_cloud_run_v2_service.worker.name
}

output "migrate_job_name" {
  description = "Cloud Run job running migrate."
  value       = google_cloud_run_v2_job.migrate.name
}

output "wif_provider_name" {
  description = "Full Workload Identity Provider resource name for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account_email" {
  description = "Service account the GitHub workflow impersonates."
  value       = google_service_account.deploy.email
}

output "app_service_account_email" {
  description = "Service account the services and job run as."
  value       = google_service_account.app.email
}

output "signing_key_version" {
  description = "KMS key version used for signing (SIGNER_GCP_KMS_KEY)."
  value       = local.signing_key_version
}

output "evidence_bucket_name" {
  description = "GCS bucket holding evidence bundles."
  value       = google_storage_bucket.evidence.name
}

output "admin_password_secret" {
  description = "Secret Manager secret with the first administrator's password."
  value       = google_secret_manager_secret.app["admin-password"].secret_id
}

output "connector_secret_prefix" {
  description = "Evidence connector token references must start with this (CONNECTOR_SECRET_PREFIXES)."
  value       = local.connector_secret_prefix
}

output "connector_secret_id_prefix" {
  description = "Secret ID prefix for evidence connector tokens (gcloud secrets create <prefix><name>)."
  value       = local.connector_secret_id_prefix
}

output "sql_instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.main.name
}

output "github_variables" {
  description = "Repository or environment variables for .github/workflows/deploy-gcp.yml."
  value = {
    GCP_PROJECT_ID          = var.project_id
    GCP_REGION              = var.region
    GCP_WIF_PROVIDER        = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOY_SA           = google_service_account.deploy.email
    GCP_ARTIFACT_REPO       = local.registry_path
    CLOUD_RUN_WEB_SERVICE   = google_cloud_run_v2_service.web.name
    CLOUD_RUN_WORKER_SERVICE = google_cloud_run_v2_service.worker.name
    CLOUD_RUN_MIGRATE_JOB   = google_cloud_run_v2_job.migrate.name
    AEROTRACE_PUBLIC_URL    = local.public_url
  }
}
