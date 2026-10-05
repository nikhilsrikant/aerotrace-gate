# AeroTrace Gate in the cloud

There are three Terraform modules, one per cloud, and a GitHub Actions workflow for each. They all run the same image in the same three roles and follow the same runtime contract ([configuration.md](configuration.md)). Pick the cloud your organisation already runs; nothing in the app depends on one over another.

| Guide | Terraform | Workflow |
| --- | --- | --- |
| [AWS](aws.md) | `deploy/terraform/aws` | `.github/workflows/deploy-aws.yml` |
| [Azure](azure.md) | `deploy/terraform/azure` | `.github/workflows/deploy-azure.yml` |
| [Google Cloud](gcp.md) | `deploy/terraform/gcp` | `.github/workflows/deploy-gcp.yml` |

## What each cloud uses

| Concern | AWS | Azure | Google Cloud |
| --- | --- | --- | --- |
| Compute: web | ECS Fargate service behind an ALB | Container App, external ingress | Cloud Run service |
| Compute: worker | ECS Fargate service, scales on CPU | Container App, KEDA scaler on the job queue | Cloud Run service, CPU always on |
| Compute: migrate | ECS task (`run-task`) | Container Apps Job, manual trigger | Cloud Run job |
| Network | VPC, private subnets, NAT | VNet, delegated subnets, private endpoints | VPC, Direct VPC egress |
| Database | RDS PostgreSQL 16, Multi-AZ | PostgreSQL Flexible Server 16, zone-redundant HA | Cloud SQL PostgreSQL 16, regional |
| Evidence storage | S3, SSE-KMS, versioned | Blob Storage, versioned, no shared keys | GCS, versioned, optional CMEK |
| Decision signing (ES256) | KMS `ECC_NIST_P256` key | Key Vault `EC-HSM` P-256 key | Cloud KMS `EC_SIGN_P256_SHA256`, HSM |
| Secrets | Secrets Manager | Key Vault secrets | Secret Manager |
| Observability | ADOT collector to X-Ray and CloudWatch (EMF) | Collector to Application Insights / Log Analytics | Collector to Cloud Trace and Cloud Monitoring |
| Alerts | CloudWatch alarms to SNS email | Azure Monitor alerts to an action group | Cloud Monitoring policies to an email channel |
| App identity | ECS task role | User-assigned managed identity | Service account |
| CI identity | GitHub OIDC to an IAM role | Federated credential on an Entra app | Workload Identity Federation |
| Registry | ECR, immutable tags | ACR, admin user off | Artifact Registry, immutable tags |
| TLS | ACM certificate on the ALB | Managed certificate on the custom domain | Google-managed (`*.run.app`, domain mapping or a load balancer) |

## Architecture

```
                 browser (passkeys need https on the final hostname)
                                   |
                       TLS 1.2+ / load balancer or ingress
                                   |
          +------------------------+-------------------------------+
          |  private network                                       |
          |                                                        |
          |   web  (x2+) --------+          worker (x1..N)         |
          |   :3000 /api/health  |          :9464 /healthz         |
          |      |  + otel       |             |  + otel           |
          |      |    sidecar    |             |    sidecar        |
          |      v               v             v                   |
          |   PostgreSQL 16 (private, TLS) <---+                   |
          |                                                        |
          |   migrate (one-shot, before every rollout)             |
          +---------+--------------+---------------+---------------+
                    |              |               |
             object storage    KMS / Key Vault   secret manager
             (evidence)        (sign, getPub)    (*_REF lookups)
                    |
          traces + metrics -> cloud monitoring  -> alerts -> email
```

The release order is the same everywhere: build and push the image, run `migrate` and wait for it to exit 0, then roll web and worker. If migrate fails, the running version stays in place.

## Things that are the same on every cloud

- **No secrets in task definitions or Terraform variables.** The app gets `DATABASE_URL_REF`, `SESSION_SECRET_REF` and `ADMIN_PASSWORD_REF` pointing at the cloud's secret store and reads them with its own identity. If the image you run does not resolve `*_REF` yet, set `secret_delivery = "platform"` and the platform injects the values instead. Generated passwords do pass through Terraform state, so keep state in an encrypted, access-controlled backend.
- **Private database.** No public IP, TLS required, reachable only from the app.
- **Deletion protection on by default.** Set `deletion_protection = false` and apply before a teardown.
- **Signing keys never leave the HSM or KMS.** Rotation creates a new key or version; the app keeps every public key it has used, and `GET /api/keys` lists them, so old decisions still verify.
- **Image is not managed by Terraform after the first apply.** The workflow rolls new images; Terraform ignores the image field so an apply does not roll you back.
- **Names** are `<name_prefix>-<environment>-...`, `aerotrace-prod-...` by default, and every resource carries `application`, `environment` and `managed-by` tags or labels.
- **Alert rules** are in [deploy/otel/alerts.md](../../deploy/otel/alerts.md).

## Pick the hostname first

Passkeys are bound to the host in `PUBLIC_URL` (or `RP_ID`). People who enrol on `aerotrace-prod-web.<something>.azurecontainerapps.io` or a `run.app` URL will have to enrol again when you move to `gate.example.com`. For anything beyond a quick trial, set up the final domain before the first sign-in.
