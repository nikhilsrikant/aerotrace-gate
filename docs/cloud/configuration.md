# Runtime configuration (all clouds)

One container image, `aerotrace-gate:<version>`, runs in three roles chosen by its command: `web` (port 3000), `worker` (metrics on 9464) and `migrate` (one-shot, run before each release). Health: `GET /api/health` (liveness) and `GET /api/ready` (database reachable).

Everything below is an environment variable. **Any variable can instead be given as `<NAME>_REF`**, pointing at a secret manager. The app resolves it at start-up with the platform's own identity, so no secret values sit in task definitions or Terraform state.

| Secret reference | Meaning |
| --- | --- |
| `aws-sm://<secret-id>` or `aws-sm://<secret-id>#<json-key>` | AWS Secrets Manager |
| `azure-kv://<vault-name>/<secret-name>` | Azure Key Vault secret |
| `gcp-sm://projects/<project>/secrets/<name>/versions/latest` | Google Secret Manager |
| `file:///run/secrets/<name>` | A mounted file (Kubernetes, Docker secrets) |
| `env://<OTHER_VAR>` | Another environment variable |

Example: `DATABASE_URL_REF=aws-sm://aerotrace/prod/database-url`.

## Core

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres 14+. Add `DATABASE_SSL=require` for managed databases |
| `SESSION_SECRET` | yes | 32+ random characters |
| `PUBLIC_URL` | yes | The https URL people open. Also the default passkey domain |
| `RP_ID`, `RP_ORIGINS` | no | Passkey domain and allowed origins, if they differ from `PUBLIC_URL` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | first run | Bootstrap administrator, created by `migrate` |

## Evidence storage: `STORAGE_BACKEND`

| Value | Variables | Identity it uses |
| --- | --- | --- |
| `postgres` (default) | none | Bundles stored in the database |
| `fs` | `STORAGE_FS_DIR` | Local or mounted disk |
| `s3` | `STORAGE_S3_BUCKET`, `AWS_REGION`, optional `STORAGE_S3_PREFIX`, `STORAGE_S3_KMS_KEY_ID` (SSE-KMS), `STORAGE_S3_ENDPOINT` (S3-compatible, e.g. MinIO) | AWS default credential chain (ECS task role, IRSA) |
| `azure` | `STORAGE_AZURE_ACCOUNT_URL` (`https://<account>.blob.core.windows.net`), `STORAGE_AZURE_CONTAINER` | `DefaultAzureCredential` (managed identity; `AZURE_CLIENT_ID` for a user-assigned one) |
| `gcs` | `STORAGE_GCS_BUCKET`, optional `STORAGE_GCS_PREFIX` | Application Default Credentials (the service's service account) |

## Decision signing: `SIGNER`

| Value | Variables | Key requirements |
| --- | --- | --- |
| `local` (default) | optional `SIGNING_PRIVATE_KEY` (Ed25519 PEM) | Without it, a key is generated once and kept in the database |
| `aws-kms` | `SIGNER_AWS_KMS_KEY_ID` (ARN or alias) | KMS key spec `ECC_NIST_P256`, usage `SIGN_VERIFY`. Role needs `kms:Sign`, `kms:GetPublicKey` |
| `azure-kv` | `SIGNER_AZURE_KEY_ID` (`https://<vault>.vault.azure.net/keys/<name>`) | EC key, curve P-256 (HSM-backed in Premium vaults). Identity needs *Key Vault Crypto User* |
| `gcp-kms` | `SIGNER_GCP_KMS_KEY` (`projects/…/cryptoKeys/<k>/cryptoKeyVersions/<n>`) | Algorithm `EC_SIGN_P256_SHA256` (protection level HSM recommended). Needs `roles/cloudkms.signerVerifier` |

Cloud signers use ES256 (ECDSA P-256, SHA-256), which all three clouds support in hardware. Every public key ever used is kept, so signatures stay verifiable after rotation. `GET /api/keys` lists them all.

## Observability

| Variable | Notes |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | e.g. `http://localhost:4318` for a collector sidecar. Unset means OpenTelemetry is off |
| `OTEL_SERVICE_NAME` | `aerotrace-web` / `aerotrace-worker` |
| `OTEL_RESOURCE_ATTRIBUTES` | e.g. `deployment.environment=prod,cloud.provider=aws` |

The collector configurations for CloudWatch/X-Ray, Azure Monitor and Google Cloud Operations are in `deploy/otel/`.

## Workers

| Variable | Default | Notes |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | 2 | Jobs per worker at once |
| `SCHEDULER_INTERVAL_MS` | 30000 | How often due schedules are checked |
| `WORKER_METRICS_PORT` | 9464 | Prometheus metrics and health for the worker |

## Evidence connectors

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONNECTOR_SECRET_PREFIXES` | `env://CONNECTOR_` | Comma-separated prefixes a source's token references must start with, for example `aws-sm://aerotrace/connectors/,azure-kv://aerotrace-kv/connector-`. Keep connector tokens apart from the app's own secrets |
| `CONNECTOR_ALLOWED_HOSTS` | empty | Hosts connectors may reach on private addresses, or over plain http (GitHub Enterprise or Jira Data Center inside your network) |
| `CONNECTOR_MAX_BYTES` | 536870912 | Largest single download (archive or artifact) |

Grant the app identity read access to the connector secrets only (for example `secretsmanager:GetSecretValue` on `aerotrace/connectors/*`). The worker makes the calls, so it needs outbound https to your Git host, Jira and CI.

