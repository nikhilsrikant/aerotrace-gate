# AeroTrace Gate on Google Cloud

From an empty project to a running gate with GitHub deploying releases. Terraform is in `deploy/terraform/gcp`, the workflow in `.github/workflows/deploy-gcp.yml`.

## What gets built

- The APIs the deployment needs, a VPC with one subnet, and private services access for Cloud SQL.
- Cloud SQL for PostgreSQL 16: private IP only, regional (standby in a second zone), daily backups kept 14 times, point-in-time recovery, `ssl_mode = ENCRYPTED_ONLY`, deletion protection at both the Terraform and API level.
- Cloud KMS key ring and key `aerotrace-signing` (`ASYMMETRIC_SIGN`, `EC_SIGN_P256_SHA256`, HSM protection).
- A GCS bucket for evidence: uniform access, public access prevention enforced, versioning, optional CMEK, ARCHIVE class after 365 days.
- Secret Manager secrets `aerotrace-prod-database-url`, `-session-secret`, `-admin-password`, `-db-password`.
- An Artifact Registry Docker repository with immutable tags.
- A service account for the app with exactly: Cloud SQL client, Secret Manager accessor on three secrets and on secrets named `aerotrace-prod-connector-*`, signer/verifier and public key viewer on the signing key, object admin on the bucket, and metric, trace and log writer.
- Cloud Run:
  - `aerotrace-prod-web`: public ingress, port 3000, 1 to 10 instances, startup and liveness probes on `/api/health`, CPU only during requests;
  - `aerotrace-prod-worker`: internal ingress, at least 1 instance, CPU always on so background jobs keep running, probes on `:9464/healthz`;
  - `aerotrace-prod-migrate`: a Cloud Run job.
  All of them use Direct VPC egress to reach Cloud SQL (no connector). Web and worker each run an OpenTelemetry collector sidecar; the app container starts after the collector's health check passes.
- Alert policies and an email notification channel.
- Workload Identity Federation for GitHub and a deploy service account.

## Prerequisites

- A project with billing on, and an account with *Owner* on it for the first apply.
- Terraform 1.6 or later, the gcloud CLI, Docker with buildx.
- The final hostname and its DNS, if you will not use the `run.app` URL.

## 1. Configure

```bash
gcloud auth application-default login
cd deploy/terraform/gcp
cp terraform.tfvars.example terraform.tfvars
```

Set `project_id`, `admin_email`, `github_repo` and `alert_email`. Set `public_url` now if you know the final hostname. Use a `gcs` backend for state (a private, versioned bucket). State holds the generated passwords.

If the image you will run cannot read `*_REF` variables yet, set `secret_delivery = "platform"`. Cloud Run then mounts the secrets as environment variables itself.

## 2. Create the repository and push the first image

```bash
terraform init
terraform apply -target=google_artifact_registry_repository.main

REPO=$(terraform output -raw artifact_registry_repo)
gcloud auth configure-docker "${REPO%%/*}" --quiet

cd ../../..
docker buildx build --platform linux/amd64 --build-arg VERSION=3.0.0 -t "$REPO/aerotrace-gate:3.0.0" --push .
cd deploy/terraform/gcp
```

## 3. Apply everything

```bash
terraform plan -out tf.plan
terraform apply tf.plan
```

About 15 to 20 minutes, most of it Cloud SQL. If the first apply fails with an API "not enabled" error, wait a minute and apply again; new APIs take a little while to switch on.

## 4. Run migrate the first time

```bash
gcloud run jobs execute "$(terraform output -raw migrate_job_name)" --region us-central1 --wait
```

Logs are in Cloud Logging under the job. Migrate builds the schema and creates the first administrator.

Then start fresh revisions of web and worker so they come up against the ready schema:

```bash
for svc in $(terraform output -raw web_service_name) $(terraform output -raw worker_service_name); do
  gcloud run services update "$svc" --region us-central1 --update-labels "restarted=$(date +%s)"
done
```

## 5. Domain and TLS

`terraform output web_run_url` already serves HTTPS with a Google certificate. That is fine for a trial, but passkeys enrolled there will not carry over to a different hostname later. Two ways to use your own name:

- **Load balancer (recommended for production).** A global external Application Load Balancer with a serverless network endpoint group pointing at the web service, a Google-managed certificate, and Cloud Armor if you want a WAF. This module does not build it. Once it is in place, consider setting the web service's ingress to internal plus load balancing, and set `allow_unauthenticated` to match your setup.
- **Cloud Run domain mapping.** Simpler, available in a subset of regions: `gcloud beta run domain-mappings create --service aerotrace-prod-web --domain gate.example.com --region us-central1`, then create the DNS records it prints.

Set `public_url = "https://gate.example.com"` and apply; Cloud Run rolls a new revision with the new `PUBLIC_URL`.

```bash
curl -fsS https://gate.example.com/api/health
curl -fsS https://gate.example.com/api/ready
```

## 6. First sign-in

```bash
gcloud secrets versions access latest --secret aerotrace-prod-admin-password
```

Sign in with `admin_email` and that password, set a new password, then enrol a passkey. Passkeys are bound to the host in `PUBLIC_URL`; set `RP_ID` and `RP_ORIGINS` in `extra_environment` before anyone enrols if the app has more than one name.

## 7. Connect GitHub

The workflow authenticates through Workload Identity Federation, builds and pushes to Artifact Registry, updates the migrate job's image and runs it with `--wait` (a failed execution stops the workflow), then updates the `app` container of web and worker. `gcloud run services update` waits until the new revision is serving and fails if it never becomes ready. It finishes with `/api/health` and `/api/ready` on the public URL.

1. Create the GitHub environment `production`, with reviewers if you want, and deployment branches limited to `main` and tags `v*`.
2. Copy the variables:

```bash
terraform output -json github_variables | jq -r 'to_entries[] | "\(.key)\t\(.value)"' |
  while IFS=$'\t' read -r k v; do gh variable set "$k" --env production --body "$v"; done
```

| Variable | Terraform output |
| --- | --- |
| `GCP_PROJECT_ID`, `GCP_REGION` | project and region |
| `GCP_WIF_PROVIDER` | `wif_provider_name` |
| `GCP_DEPLOY_SA` | `deploy_service_account_email` |
| `GCP_ARTIFACT_REPO` | `artifact_registry_repo` |
| `CLOUD_RUN_WEB_SERVICE`, `CLOUD_RUN_WORKER_SERVICE` | `web_service_name`, `worker_service_name` |
| `CLOUD_RUN_MIGRATE_JOB` | `migrate_job_name` |
| `AEROTRACE_PUBLIC_URL` | `web_url` |

3. Run *Actions → deploy-gcp → Run workflow*, or push a `v*` tag.

The identity pool only accepts tokens from your repository on `main` or a `v*` tag. The deploy service account has `roles/run.admin` on the project (Cloud Run needs it to create revisions and job executions; narrow to `roles/run.developer` plus per-service bindings if your policy requires), `roles/artifactregistry.writer` on the one repository, and *Service Account User* on the app service account only.

If you turn `allow_unauthenticated` off, the smoke test cannot reach the service without a token; put the load balancer's URL in `AEROTRACE_PUBLIC_URL` or remove that step.

Terraform ignores the app image on the services and the job. Everything else applies immediately as a new revision.

## Alerts

Cloud Run 5xx ratio, Cloud SQL CPU and Cloud SQL disk alerts exist from the start. The approval-age alert watches `custom.googleapis.com/aerotrace/aerotrace.approvals.oldest_age_seconds`, and Cloud Monitoring refuses to create an alert on a metric it has never received. Once the app has been up for a few minutes, set `enable_app_metric_alerts = true` and apply.

## Evidence connector tokens

Evidence sources ([connectors.md](../connectors.md)) read their Git, Jira and CI tokens from Secret Manager. Terraform sets `CONNECTOR_SECRET_PREFIXES=gcp-sm://projects/<project id>/secrets/aerotrace-prod-connector-` on web and worker. It also gives the app service account *Secret Manager Secret Accessor* on the project, with an IAM condition that only matches secrets whose ID starts with `aerotrace-prod-connector-`. It creates no secrets; you add them:

```bash
printf '%s' 'github_pat_...' | gcloud secrets create aerotrace-prod-connector-github \
  --replication-policy=automatic --data-file=- --labels=application=aerotrace-gate
```

In the source, type `gcp-sm://projects/my-aerotrace-project/secrets/aerotrace-prod-connector-github/versions/latest`. Use the project ID here. The IAM condition uses the project number because that is how Secret Manager names resources, but the API accepts either in a request. `terraform output connector_secret_prefix` prints the prefix for your project, name and environment.

If GitHub Enterprise or Jira Data Center sits on a private address, set `connector_allowed_hosts = "github.internal.example.com"` and apply. The services send private-range traffic through the VPC, so that host has to be reachable from the subnet. The new value applies right away as a new revision.

## Rotating the signing key

`SIGNER_GCP_KMS_KEY` names one key version. To rotate:

```bash
gcloud kms keys versions create --key aerotrace-signing \
  --keyring "$(terraform output -raw signing_key_version | cut -d/ -f6)" --location us-central1
```

Note the new version number (2 for the first rotation), set `signing_key_version = 2` in `terraform.tfvars` and `terraform apply`. Cloud Run rolls new revisions that sign with version 2. `https://gate.example.com/api/keys` should list both public keys; the app keeps every key it has used, so earlier decisions still verify.

Then stop the old version from signing:

```bash
gcloud kms keys versions disable 1 --key aerotrace-signing \
  --keyring "$(terraform output -raw signing_key_version | cut -d/ -f6)" --location us-central1
```

Disable rather than destroy, so the public key can still be fetched from KMS if an auditor asks.

## Backups and restore

- **Database.** 14 daily backups and 7 days of point-in-time recovery (`db_pitr_days`).
- **Evidence.** Object versioning keeps every overwritten or deleted version.

Point-in-time restore into a new instance:

```bash
gcloud sql instances clone "$(terraform output -raw sql_instance_name)" aerotrace-prod-pg-restored \
  --point-in-time "2026-10-01T09:30:00Z"
```

Or restore a backup over an instance: `gcloud sql backups list --instance <name>`, then `gcloud sql backups restore <id> --restore-instance <target>`. After a clone, add a new version of the `aerotrace-prod-database-url` secret with the new private IP and start new revisions (the restart command in step 4). Bring the new instance under Terraform with `terraform import` if you keep it.

An earlier evidence object: `gcloud storage ls -a gs://<bucket>/<path>` lists generations; copy the one you want back with `gcloud storage cp`.

## Pilot or production

| Setting | Pilot | Production |
| --- | --- | --- |
| `db_tier` | `db-custom-1-3840` | `db-custom-2-7680` or larger |
| `db_availability_type` | `ZONAL` | `REGIONAL` |
| `kms_protection_level` | `SOFTWARE` | `HSM` |
| `web_min_instances` | 0 (cold starts) | 1-2 |
| `worker_min_instances` / `worker_max_instances` | 1 / 2 | 1 / 5-10 |
| `worker_cpu` / `worker_memory` | `1` / `2Gi` | `2` / `4Gi` |
| `collector_cpu` | `1` | `1` |

The worker keeps CPU allocated all the time, so it bills for every instance-second; that and Cloud SQL are the main costs. Web with `web_min_instances = 0` costs almost nothing when idle.

## Teardown

1. Set `deletion_protection = false` and `terraform apply`.
2. Empty the evidence bucket, every version: `gcloud storage rm --all-versions "gs://$(terraform output -raw evidence_bucket_name)/**"`.
3. `terraform destroy`.

KMS key rings cannot be deleted. The signing key's versions are scheduled for destruction with a 30-day window (`gcloud kms keys versions restore` undoes it). Cloud SQL instance names and workload identity pool IDs stay reserved for a while after deletion, which is why both carry a random suffix. The private services access peering is left in place on purpose; it goes away with the VPC.

## Notes

- Cloud Run has no read-only root filesystem switch. The container still runs as UID 10001 and `/tmp` is an in-memory volume (it counts against the memory limit).
- Cloud Run gives a container 10 seconds after SIGTERM, so the worker's `WORKER_SHUTDOWN_GRACE_MS` is set to 8000. Jobs that are cut off are picked up again once their heartbeat goes stale.
- With CPU only during requests (`cpu_idle = true`) on web, the collector exports in short bursts while requests are served. Metrics from web can lag a little at quiet times; the worker's collector runs continuously.
- The migrate job has no collector sidecar, because a sidecar that never exits would hold the job open. OpenTelemetry is off for migrate.
