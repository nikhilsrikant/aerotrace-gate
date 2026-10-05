# Deploying AeroTrace Gate

## 1. Build or pull the image

```bash
docker build -t aerotrace-gate:3.0.0 .
```

CI (`.github/workflows/ci.yml`) builds, tests, scans with Trivy, attaches an SBOM and provenance, signs with cosign on tags, and pushes to GHCR.

**Air-gapped sites.** Build inside the network against your own mirrors:

```bash
docker build \
  --build-arg NODE_IMAGE=registry.internal/library/node:22-bookworm-slim \
  --build-arg NPM_REGISTRY=https://artifactory.internal/api/npm/npm/ \
  -t registry.internal/aerotrace/aerotrace-gate:3.0.0 .
```

Or build outside and carry the image in:

```bash
docker save aerotrace-gate:3.0.0 | gzip > aerotrace-gate-3.0.0.tar.gz
# on the inside:
docker load < aerotrace-gate-3.0.0.tar.gz
```

Fonts are bundled in the image, so nothing reaches the internet at runtime. The only outbound calls are ones you turn on: SSO discovery, the LLM endpoint and webhooks.

## 2. One host: Docker Compose

```bash
cp .env.example .env    # fill in the required block
docker compose up -d
docker compose up -d --scale worker=4             # more workers
docker compose --profile monitoring up -d         # Prometheus on :9090, Grafana on :3001
```

Put TLS in front of port 3000: your load balancer, nginx, or Caddy. Set `PUBLIC_URL` to the https address so cookies are marked Secure and HSTS is sent.

## 3. Kubernetes

Prerequisites:
- Kubernetes 1.27 or later
- An ingress controller
- Postgres 14 or later (managed or an operator such as CloudNativePG)
- KEDA 2.12 or later, for worker autoscaling

```bash
# 1. secrets: replace deploy/k8s/secret.example.yaml with your secret manager, or edit it
# 2. image: set images[].newName/newTag in deploy/k8s/kustomization.yaml
kubectl apply -k deploy/k8s
kubectl -n aerotrace wait --for=condition=complete job/aerotrace-migrate --timeout=5m
```

For each release, run the migrate job first, then roll the deployments:

```bash
kubectl -n aerotrace create job --from=job/aerotrace-migrate migrate-$(date +%s)
kubectl -n aerotrace set image deploy/aerotrace-web web=registry.internal/aerotrace/aerotrace-gate:3.0.0
kubectl -n aerotrace set image deploy/aerotrace-worker worker=registry.internal/aerotrace/aerotrace-gate:3.0.0
```

Migrations take an advisory lock, so running two at once is safe.

**Autoscaling.** `keda-scaledobject.yaml` scales workers on the number of jobs ready to run. That is the queue itself, not CPU, so a nightly wave of scheduled audits gets more workers within one polling interval and they scale back down after five quiet minutes.

**Hardening already in the manifests:**
- The namespace enforces the `restricted` Pod Security level.
- Pods run as non-root with a read-only root filesystem, all capabilities dropped and the RuntimeDefault seccomp profile.
- Disruption budgets keep at least one web pod and one worker pod running during node maintenance.
- Pods spread across nodes.
- Network policies limit inbound traffic to the web port and the worker metrics port.

## 4. Single sign-on

Any OpenID Connect provider works. Microsoft Entra ID, Okta, Ping and Keycloak have been the usual ones.

1. Register a web application. Redirect URI: `${PUBLIC_URL}/api/auth/sso/callback`.
2. Ask the provider to include a `groups` claim. For Entra ID, add the groups claim in Token configuration, and emit group names (or map IDs).
3. Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and, optionally, `OIDC_LABEL` and `OIDC_GROUPS_CLAIM`.
4. In **Users, groups, roles → Groups**, set each group's *Matching group in your identity provider*. Members join and leave at each sign-in.
5. When SSO works, set `DISABLE_LOCAL_LOGIN=true`. Keep one break-glass local admin first, created with `aerotrace create-admin`.

## 5. Passkeys

Every person verifies with their own passkey before any audit data opens, and each Approve or Deny is signed by the approver's passkey. Passkeys need two things from the deployment:

- **HTTPS on a real hostname.** Browsers only offer passkeys on `https://` (or `http://localhost` for trials). An IP address won't work.
- **A stable domain.** A passkey is bound to `RP_ID` (by default the host in `PUBLIC_URL`). Choose the final name before people enrol. If the app is reached on more than one URL, list them all in `RP_ORIGINS`. Setting `RP_ID` to a parent domain (for example `example.com`) lets the same passkeys work on `gate.example.com` and `gate-dr.example.com`.

Supported authenticators: Touch ID and Face ID (Mac, iPhone, iPad), Windows Hello, Android, and FIDO2 security keys such as YubiKey. Synced passkeys (iCloud Keychain, Google Password Manager) and device-bound security keys both work; the Security page shows which kind each one is. Fingerprint, face or PIN is required every time (user verification), so a stolen unlocked laptop isn't enough by itself.

Policy lives in **Settings → Passkeys**: whether passkeys are required, whether decisions are passkey-signed, how recent a check must be for sensitive steps (5 minutes by default) and which steps count as sensitive. Every change is audit-logged.

New people: add them on **Users, groups, roles**. The app shows a one-time invite link to send them. They open it and set up a passkey on their own device. No temporary password is needed (you can still set one as a fallback sign-in).

Approved hardware only: in **Settings → Passkeys**, add the AAGUIDs of the security-key models you issue (from the vendor's FIDO metadata) and paste the vendor's attestation root certificate. From then on only those models can enrol, and each must prove it with a vendor certificate.

Lost device: an administrator opens **Users, groups, roles** and clicks *Reset passkeys*, which also produces a new invite link. The person is signed out everywhere and sets up a new passkey at next sign-in. If the only administrator loses theirs: `aerotrace reset-passkeys --email admin@…` from the container (break-glass, audit-logged).

API tokens still start audits from CI. They can never approve, deny, or do anything on the sensitive-step list.

## 6. First sign-in

`migrate` creates the administrator from `ADMIN_EMAIL` / `ADMIN_PASSWORD`, who must change the password at first sign-in and then set up a passkey. It also loads example roles, groups and three approval policies. Edit or delete all of them to match your organisation.

## Environment reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. Add `DATABASE_SSL=require` for TLS. |
| `SESSION_SECRET` | yes | 32+ random characters. Signs the SSO round-trip cookie. |
| `PUBLIC_URL` | yes in production | External https URL. Used for SSO redirects, links in notifications and Secure cookies. |
| `RP_ID` / `RP_ORIGINS` / `RP_NAME` | no | Passkey domain, allowed origins and display name. Default: the host and origin of `PUBLIC_URL`, and the organisation name |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | first run | Bootstrap administrator |
| `SIGNING_PRIVATE_KEY` | recommended | Ed25519 PEM for decision signatures. Without it, a key is generated once and stored in the database. |
| `OIDC_*` | for SSO | See above |
| `LLM_PROVIDER` / `LLM_MODEL` | no | `none`, `anthropic` (with `ANTHROPIC_API_KEY`) or `openai` (with `OPENAI_BASE_URL`, for vLLM, Azure OpenAI or a gateway) |
| `WORKER_CONCURRENCY` | no | Jobs per worker at once (default 2) |
| `SCHEDULER_INTERVAL_MS` | no | How often workers check schedules (default 30000) |
| `JOB_STALE_MS` | no | Heartbeat age after which a job is requeued (default 120000) |
| `MAX_UPLOAD_MB` | no | Evidence bundle size limit (default 200) |
| `METRICS_TOKEN` | no | If set, `/api/metrics` needs `Authorization: Bearer <token>` |
| `SESSION_HOURS` | no | Session length (default 12) |
| `SEED_DEMO_DATA` | no | Load the synthetic 50,000-record program on first run (default true) |
| `LOG_LEVEL` | no | debug, info, warn, error. Logs are JSON lines on stdout. |

## Cloud

Terraform modules and GitHub deploy workflows for managed cloud services:

- [Cloud overview and comparison](cloud/README.md)
- [Runtime configuration for all clouds](cloud/configuration.md)
- [AWS: ECS Fargate, RDS, S3, KMS](cloud/aws.md)
- [Azure: Container Apps, PostgreSQL Flexible Server, Blob Storage, Key Vault](cloud/azure.md)
- [Google Cloud: Cloud Run, Cloud SQL, GCS, Cloud KMS](cloud/gcp.md)
- [Alert rules](../deploy/otel/alerts.md)
