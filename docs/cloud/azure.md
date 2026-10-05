# AeroTrace Gate on Azure

From an empty subscription to a running gate with GitHub deploying releases. Terraform is in `deploy/terraform/azure`, the workflow in `.github/workflows/deploy-azure.yml`.

## What gets built

- A resource group `aerotrace-prod-rg` and a VNet with three subnets: one delegated to Container Apps, one delegated to PostgreSQL Flexible Server, one for private endpoints.
- PostgreSQL Flexible Server 16 with private access only (VNet integration and a private DNS zone), zone-redundant HA, 14 days of geo-redundant backups, TLS 1.2 minimum, and a delete lock.
- Key Vault (Premium, RBAC mode, purge protection, 90-day soft delete) holding:
  - `aerotrace-signing`, an `EC-HSM` P-256 key with `sign` and `verify` only;
  - secrets `database-url`, `session-secret`, `admin-password`, `postgres-admin-password`, `worker-scaler-connection`, `appinsights-connection-string`.
- A second, empty Key Vault (Standard, same RBAC, purge protection, network rules and private endpoint) for evidence connector tokens.
- A storage account for evidence: shared keys disabled, public network access off, TLS 1.2, infrastructure encryption, versioning, 30-day soft delete, a private endpoint, and a rule that moves blobs to the Cold tier after 365 days.
- A user-assigned managed identity for the app with *Key Vault Crypto User* on the signing key, *Key Vault Secrets User* on the five secrets it reads and on the connector vault, *Storage Blob Data Contributor* on the storage account and *AcrPull* on the registry.
- Azure Container Registry (admin user off).
- Log Analytics, workspace-based Application Insights, and Key Vault and Postgres diagnostic logs.
- A Container Apps environment on the VNet with:
  - `aerotrace-prod-web`: external HTTPS ingress on port 3000, 2 to 6 replicas, startup, liveness and readiness probes;
  - `aerotrace-prod-worker`: no ingress, 1 to 10 replicas, scaled by KEDA on the number of ready jobs in Postgres;
  - `aerotrace-prod-migrate`: a Container Apps Job you start before each release.
  Web and worker each carry an OpenTelemetry collector sidecar that sends traces and metrics to Application Insights.
- Alerts to an email action group.
- An Entra application with federated credentials so GitHub can deploy without a client secret.

## Prerequisites

- An Azure subscription where you are *Owner* (Terraform creates role assignments), and rights in Entra ID to create an application registration.
- Terraform 1.6 or later, the Azure CLI with the `containerapp` extension (`az extension add -n containerapp`), Docker with buildx.
- The final hostname and access to its DNS.
- Register the resource providers once: `az provider register -n Microsoft.App`, `Microsoft.ContainerService`, `Microsoft.DBforPostgreSQL`, `Microsoft.OperationalInsights`, `Microsoft.KeyVault`.

## 1. Configure

```bash
az login
cd deploy/terraform/azure
cp terraform.tfvars.example terraform.tfvars
```

Set `subscription_id`, `admin_email`, `github_repo`, `alert_email` and `custom_domain`. Put your public IP in `key_vault_allowed_ips` so the vault denies everyone else; Terraform itself writes the key and secrets through the vault's public endpoint. Configure a remote state backend (an `azurerm` backend with Entra auth). State holds the generated passwords.

If the image you will run cannot read `*_REF` variables yet, set `secret_delivery = "platform"`. Container Apps then resolves the Key Vault secrets and passes `DATABASE_URL`, `SESSION_SECRET` and `ADMIN_PASSWORD` as environment variables.

## 2. Create the registry and push the first image

Container Apps will not create a revision whose image does not exist, so push one first.

```bash
terraform init
terraform apply -target=azurerm_container_registry.main

ACR=$(terraform output -raw registry_name)
SERVER=$(terraform output -raw registry_login_server)
az acr login --name "$ACR"

cd ../../..
docker buildx build --platform linux/amd64 --build-arg VERSION=3.0.0 -t "$SERVER/aerotrace-gate:3.0.0" --push .
cd deploy/terraform/azure
```

`az acr build --registry "$ACR" --image aerotrace-gate:3.0.0 --build-arg VERSION=3.0.0 ../../..` works too if you have no local Docker.

## 3. Apply everything

```bash
terraform plan -out tf.plan
terraform apply tf.plan
```

Expect 20 to 40 minutes; the Container Apps environment and zone-redundant Postgres are the slow parts. Two pauses of 60 seconds are built in so role assignments reach Key Vault before Terraform and Container Apps use them.

## 4. Run migrate the first time

```bash
RG=$(terraform output -raw resource_group_name)
JOB=$(terraform output -raw migrate_job_name)
EXEC=$(az containerapp job start -n "$JOB" -g "$RG" --query name -o tsv)
az containerapp job execution show -n "$JOB" -g "$RG" --job-execution-name "$EXEC" --query properties.status -o tsv
# repeat until Succeeded
```

Logs: in Log Analytics, `ContainerAppConsoleLogs_CL | where ContainerJobName_s == "aerotrace-prod-migrate"`.

Web and worker replicas started before the schema existed. Restart them:

```bash
for app in $(terraform output -raw web_app_name) $(terraform output -raw worker_app_name); do
  rev=$(az containerapp show -n "$app" -g "$RG" --query properties.latestRevisionName -o tsv)
  az containerapp revision restart -n "$app" -g "$RG" --revision "$rev"
done
```

## 5. Custom domain and TLS

Without a custom domain the app answers on `terraform output web_fqdn` with a Microsoft certificate. For your own name:

1. Create two DNS records:
   - `TXT asuid.gate.example.com` = `terraform output -raw custom_domain_verification_id`
   - `CNAME gate.example.com` = `terraform output -raw web_fqdn`
2. Set `custom_domain = "gate.example.com"` and `terraform apply`. This adds the hostname to the app and changes `PUBLIC_URL`.
3. Bind a free managed certificate:

```bash
az containerapp hostname bind -g "$RG" -n "$(terraform output -raw web_app_name)" \
  --hostname gate.example.com \
  --environment "$(terraform output -raw container_app_environment_name)" \
  --validation-method CNAME
```

Certificate issuance takes a few minutes. Then:

```bash
curl -fsS https://gate.example.com/api/health
curl -fsS https://gate.example.com/api/ready
```

## 6. First sign-in

```bash
az keyvault secret show --vault-name "$(terraform output -raw key_vault_name)" --name admin-password --query value -o tsv
```

Sign in at `https://gate.example.com` with `admin_email` and that password, choose a new password, then enrol a passkey. The passkey is tied to the host in `PUBLIC_URL`. If people will reach the app on more than one name, set `RP_ID` and `RP_ORIGINS` in `extra_environment` before anyone enrols.

## 7. Connect GitHub

The workflow logs in with OIDC, builds and pushes to ACR, points the migrate job at the new image, starts it and polls until the execution is `Succeeded`, then updates the `app` container of web and worker and waits for each new revision to be provisioned and healthy. It ends with `/api/health` and `/api/ready` against the public URL.

1. Create the GitHub environment `production`, with reviewers if you want an approval gate, and deployment branches limited to `main` and tags `v*`.
2. Copy the variables:

```bash
terraform output -json github_variables | jq -r 'to_entries[] | "\(.key)\t\(.value)"' |
  while IFS=$'\t' read -r k v; do gh variable set "$k" --env production --body "$v"; done
```

| Variable | Terraform output |
| --- | --- |
| `AZURE_CLIENT_ID` | `deploy_client_id` |
| `AZURE_TENANT_ID` | `tenant_id` |
| `AZURE_SUBSCRIPTION_ID` | `subscription_id` |
| `AZURE_RESOURCE_GROUP` | `resource_group_name` |
| `ACR_NAME`, `ACR_LOGIN_SERVER` | `registry_name`, `registry_login_server` |
| `ACA_WEB_APP`, `ACA_WORKER_APP` | `web_app_name`, `worker_app_name` |
| `ACA_MIGRATE_JOB` | `migrate_job_name` |
| `AEROTRACE_PUBLIC_URL` | `web_url` |

3. Run *Actions → deploy-azure → Run workflow*, or push a `v*` tag.

The Entra application has two federated credentials: one for `repo:<owner>/<repo>:environment:production` (what the workflow presents, since it runs in that environment) and one for the `main` branch. It holds *AcrPush* on the registry and *Contributor* on the resource group. Contributor is broader than the workflow needs. To narrow it, replace it with a custom role that allows `Microsoft.App/containerApps/*`, `Microsoft.App/jobs/*`, `Microsoft.App/managedEnvironments/join/action`, `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action` and read on the resource group.

Terraform ignores the image on the apps and the job, so `terraform apply` never rolls a release back. Other changes (environment variables, scaling) do apply right away and create a new revision.

## Evidence connector tokens

Evidence sources ([connectors.md](../connectors.md)) read their Git, Jira and CI tokens from a second Key Vault that holds nothing else. Terraform creates it with the same settings as the main vault (RBAC, purge protection, the same IP rules and a private endpoint), gives the app identity *Key Vault Secrets User* on it and gives whoever runs Terraform *Key Vault Secrets Officer*. It sets `CONNECTOR_SECRET_PREFIXES=azure-kv://<connector vault>/` on web and worker. No secrets are created; you add them:

```bash
CONNECTOR_KV=$(terraform output -raw connector_key_vault_name)
az keyvault secret set --vault-name "$CONNECTOR_KV" --name github --value 'github_pat_...'
```

In the source, type `azure-kv://<connector vault>/github`. `terraform output connector_secret_prefix` prints the part before the secret name. Secret names can use letters, digits and hyphens. If you set `key_vault_allowed_ips`, run the command from one of those addresses.

Because the app can read every secret in this vault, keep the app's own secrets in the main vault and only connector tokens here.

If GitHub Enterprise or Jira Data Center sits on a private address, set `connector_allowed_hosts = "github.internal.example.com"` and apply. The apps get a new revision with `CONNECTOR_ALLOWED_HOSTS` right away.

## Rotating the signing key

Key Vault keeps versions. `SIGNER_AZURE_KEY_ID` is the versionless key ID, so the app always signs with the current version.

```bash
az keyvault key rotate --vault-name "$(terraform output -raw key_vault_name)" --name aerotrace-signing
```

Restart web and worker so every replica picks up the new version at the same time (see step 4). `https://gate.example.com/api/keys` should then list both public keys. The app keeps every public key it has used, so older decisions keep verifying. Old key versions stay in the vault; there is no need to disable them, since the app only signs with the current one.

For scheduled rotation set `signing_key_rotation_days` (for example 365). Key Vault then creates a new version on that schedule; restart the apps after it does, or let the next deploy do it.

## Backups and restore

- **Database.** Daily backups, 14 days of point-in-time restore, copied to the paired region when `db_geo_redundant_backup` is on.
- **Evidence.** Blob versioning keeps every overwritten version; deleted blobs and containers are recoverable for 30 days.
- **Key Vault.** Soft delete for 90 days and purge protection, so a deleted key or vault can be recovered and cannot be purged early.

Restore Postgres to a point in time into a new server in the same VNet:

```bash
az postgres flexible-server restore -g "$RG" \
  --name aerotrace-prod-pg-restored \
  --source-server "$(terraform output -raw postgres_fqdn | cut -d. -f1)" \
  --restore-time "2026-10-01T09:30:00Z"
```

(`az postgres flexible-server geo-restore` does the same into the paired region.) Check the data, then put the new host into the `database-url` and `worker-scaler-connection` secrets (`az keyvault secret set`) and restart web and worker. Bring the new server under Terraform with `terraform import`, or keep it as a temporary source and copy data back with `pg_dump`/`pg_restore`.

An overwritten evidence blob: list versions with `az storage blob list --include v --auth-mode login` and copy the one you want back.

## Pilot or production

| Setting | Pilot | Production |
| --- | --- | --- |
| `db_sku` | `B_Standard_B2s` | `GP_Standard_D2ds_v5` or larger |
| `db_zone_redundant_ha` | `false` (Burstable cannot do HA) | `true` |
| `db_geo_redundant_backup` | `false` | `true` |
| `storage_replication` | `ZRS` | `GZRS` |
| `web_min_replicas` | 1 | 2 |
| `aca_zone_redundant` | `false` | `true` |
| `key_vault_sku` | `standard` (software key) | `premium` (HSM key) |
| `log_retention_days` | 30 | 90 or more |

Zone redundancy settings on the Container Apps environment and geo-redundant backup on Postgres can only be chosen at creation. Decide before the first apply.

## Teardown

1. Set `deletion_protection = false` and `terraform apply`. This removes the delete locks on Postgres, storage and the vault.
2. `terraform destroy`.

The Key Vault goes into soft delete and, with purge protection, stays there for 90 days; its name stays reserved for that time (the random suffix means a new deployment does not collide). Deleting the storage account deletes the evidence in it; copy anything you must keep first. The Entra application and its federated credentials are removed with the rest.

## Notes

- Container Apps does not offer a read-only root filesystem setting; the image's non-root user (10001) still applies, and `/tmp` is an `EmptyDir` volume.
- The migrate job has no collector sidecar. A sidecar that never exits would keep the job execution running until its timeout, so OpenTelemetry is off for migrate.
- The KEDA scaler connects to Postgres from inside the environment with its own connection string (`worker-scaler-connection`, `sslmode=require`).
- The `storage { data_plane_available = false }` provider setting keeps Terraform off the private storage endpoint. It needs a recent azurerm 4.x; if your provider rejects it, upgrade, or remove it and set `storage_public_network_access = true` while you apply.
