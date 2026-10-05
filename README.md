# AeroTrace Gate

DO-178C audit readiness, run by five agents and signed off by people. The program decides who those people are.

It started as the Devils Invent 2026 entry for Honeywell's Problem Statement 1.2 (Avionics Audit Agents). Version 3 turns it into something a program can run for real: on AWS, Azure or Google Cloud, with keys in the cloud KMS, several programs in one deployment, telemetry going to the cloud's own monitoring, and evidence pulled straight from Git, Jira and CI.

## What it does

- **Several programs, one deployment.** Each program gets a workspace with its own datasets, audits, policies, groups, schedules, tokens and settings. People sign in once and switch between the workspaces they belong to. Nothing crosses over: another workspace's audit is simply "not found".
- **Evidence pulled from where it lives.** An evidence source reads the repository at a branch or tag, problem reports from a Jira query, and test results and coverage from the GitHub Actions or GitLab run for that commit. Each sync records a dataset version with its commit and provenance, skips work when nothing changed, and can audit the new version or feed a schedule. See [docs/connectors.md](docs/connectors.md).
- **Runs on your cloud.** Terraform and a deploy workflow for each of AWS (ECS Fargate, RDS, S3, KMS), Azure (Container Apps, Flexible Server, Blob, Key Vault) and Google Cloud (Cloud Run, Cloud SQL, GCS, Cloud KMS). The same image runs on all three.
- **Keys in the KMS.** Decisions are signed ES256 by AWS KMS, Azure Key Vault or Cloud KMS; the private key never reaches the app. Every public key ever used stays listed, so decisions signed before a rotation still verify offline.
- **Telemetry.** OpenTelemetry traces and metrics over OTLP: request latency, job duration and queue depth, audits by verdict, agent latency, retries and breaker trips, approval backlog and its oldest item, passkey failures. Collector configs and alert rules for each cloud are in `deploy/otel/`.
- **Five audit agents** (Requirements, Design, Code, Testing, Configuration Management) check one module at a time across the whole evidence set. They talk only through a signed, schema-checked, hash-chained message broker.
- **Two audit layers.** Layer 1 applies fixed rules to the trace graph. Layer 2 reads requirement text and code, with an LLM or a rule-based reader. A Layer 2 claim only counts after a cross-check confirms the cited record exists and the quoted words are in it.
- **Approval you configure.** Admins define groups, roles and approval policies. A policy matches audits by dataset, module, DAL and verdict, then lists sign-off steps: who signs each step, how many people, and in what order. Delegation covers leave. Approvers just click Approve or Deny.
- **Scheduled audits.** Set schedules every N hours, every 24 hours, daily at a time, weekly, or by cron, in any time zone. Workers fire them on their own.
- **Program readiness on one screen.** The latest audit of every module, grouped by DAL, with the program verdict, agent health and latency, who talks to whom, what blocks certification and the fewest teams that would unblock it.
- **Chaos drills.** Take the Testing agent offline, make Code drop messages, have Design forge messages, or all at once, during a real audit. The report shows a scorecard: retried, isolated, rejected, still finished, chain intact.
- **Passkeys for every engineer.** A password or SSO sign-in opens nothing until the person confirms with their own passkey: Touch ID, Windows Hello, Android or a security key, with fingerprint, face or PIN. Sensitive steps such as exporting evidence or changing policies ask again after 5 minutes. Every Approve and Deny is signed on the approver's own device over the report hash, and that signature verifies offline from the evidence package. New people get a one-time invite link instead of a temporary password. Admins can restrict enrolment to approved security-key models, proven by vendor attestation that chains to a pinned root. Admins reset lost passkeys; CI tokens can never approve.
- **Ask, by typing or by voice, and get sources.** The audit assistant answers questions such as "why is BARO-IN not ready?", "who can approve it?" or "what changed since the last audit?". Every sentence carries a numbered source; clicking it opens the audit, the exact finding, the policy or the schedule. It only reads audits the person asking is allowed to see, and says so when it can't answer instead of guessing. With an LLM configured, it may only use numbered sources, and any sentence whose citation doesn't check out is dropped. Voice uses the browser's speech recognition, or an on-prem Whisper-compatible server (`STT_URL`) so audio never leaves the site.
- **Repeated manual audits get noticed.** If someone keeps auditing the same module by hand on a regular rhythm (three or more sittings, evenly spaced), the app offers to turn it into a schedule at that time of day. One click, and it runs by itself. "Automate this audit" on any report, or asking the assistant "run FUEL-MON every 24 hours", does the same.
- **Evidence you can take away.** Every decision gets a signature over the report hash (ES256 from your KMS, or Ed25519 with the built-in key). The audit log is append-only and hash-chained, and the database refuses edits to it. An evidence package can be checked offline with `scripts/verify-evidence.mjs`.
- **Your real data.** Sync it from Git, Jira and CI, or upload an evidence bundle: requirements CSV, C/Ada source with trace tags, JUnit results, coverage, a baseline checksum list and problem reports. A 50,000-record synthetic program ships as demo data.


## Run it

On one machine:

```bash
cp .env.example .env          # set POSTGRES_PASSWORD, SESSION_SECRET, PUBLIC_URL, ADMIN_EMAIL, ADMIN_PASSWORD
docker build -t aerotrace-gate:3.0.0 .
docker compose up -d          # postgres, migrate (one-shot), web, 2 workers
open http://localhost:3000    # sign in as ADMIN_EMAIL; you'll be asked to set a new password
```

On a cloud: start with [docs/cloud/README.md](docs/cloud/README.md), then the guide for [AWS](docs/cloud/aws.md), [Azure](docs/cloud/azure.md) or [Google Cloud](docs/cloud/gcp.md). On Kubernetes: `kubectl apply -k deploy/k8s` ([docs/deploy.md](docs/deploy.md)).

## What runs

| Container | Command | Scales | Purpose |
| --- | --- | --- | --- |
| web | `aerotrace web` | 2+ replicas behind a load balancer; stateless | UI, REST API, sign-in, decisions |
| worker | `aerotrace worker` | 1 to 20 replicas, KEDA on queue depth | Audit, import and evidence-sync jobs, the scheduler, retries, stale-job recovery |
| migrate | `aerotrace migrate` | one-shot per release | Schema migrations and first-run setup |
| postgres | Postgres 16 (or RDS, Flexible Server, Cloud SQL) | your HA setup | All state: users, policies, runs, jobs, audit log. Evidence bundles go to S3, Blob or GCS when configured |

The web and worker containers run from one image: non-root (UID 10001), read-only root filesystem, all Linux capabilities dropped, and a healthcheck built in.

## Origin: PS 1.2, criterion by criterion

The problem statement asks for "a multi-agent validation system where Requirements, Design, Testing, Code, and Configuration Management agents autonomously review artifact categories", exchanging "status, dependency, and blocker messages through a broker, while an orchestrator determines final audit readiness."

| Success criterion | Where it is implemented | How it is tested |
| --- | --- | --- |
| 1. Standard A2A message protocol with schemas, authorization, routing, and an auditable message trail | Published spec: [`docs/protocol.md`](docs/protocol.md) and versioned JSON Schemas in [`docs/protocol/`](docs/protocol/), served at `/api/protocol`. Enforced by `lib/engine/broker.ts`: an HMAC key per agent with the sender checked, sender/type permissions, subject routing `audit.<run>.<agent>.<type>`, every message hash-chained, rejected ones included. New agents pass `aerotrace a2a-conformance` before joining | `tests/protocol.test.ts` (schemas and broker agree on every type; real traffic conforms; a buggy agent fails conformance); `tests/audit.test.ts`; `scripts/verify-evidence.mjs` re-checks the trail offline |
| 2. Orchestrator collects agent status, identifies critical-path blockers, and recommends next actions | Per audit: `lib/engine/audit.ts` (dependency and blocker exchange, `buildCriticalPath`, `buildActions`). Program-wide: `lib/core/program.ts` ranks every blocker across all modules and finds the smallest set of owners that unblocks the most modules; "What if we fixed these?" on each report re-runs the same verdict rule | `tests/program.test.ts`; `tests/e2e.ts` |
| 3. Robustness for timeouts, retries, queues, circuit breakers, offline agents, and recovery | `lib/engine/audit.ts`: ack timeout, 3 retries with backoff, a breaker per agent, heartbeats, offline state; `lib/server/worker.ts`: Postgres job queue, retries, stale-job reaper. One-click chaos drills (`lib/core/chaos.ts`) break agents during a real audit and score the outcome against what should happen | Every drill preset in `tests/program.test.ts`; a live drill and worker-death recovery in `tests/e2e.ts` |
| 4. Dashboard/report shows agent health, message flow, latency, failures, and readiness YES / NO / CONDITIONAL | Program readiness page (`ui/views/Program.tsx`): program verdict, all 40 modules by DAL, agent health and p95 latency per audit, the message-flow matrix, retries and verdicts per day. Per audit: `ui/views/RunDetail.tsx`. Markdown and evidence-package exports | `tests/program.test.ts`; `GET /api/program`; screens in the browser demo |

## Configure authority (no code changes)

1. **Users, groups, roles.** Roles grant permissions such as "start audits", "edit approval policies" or "read the audit log". Groups bundle people, and can map to an SSO group so membership follows your identity provider.
2. **Approval policies.** For example, *DAL A and B: Software Quality, then Certification (DER), in order, a reason required to deny.* Policies are matched by priority. The "Who would sign this?" simulator shows who would approve a case before you save.
3. **Delegations.** A signer hands their authority to a colleague for set dates. Each signature records who signed on whose behalf.
4. A policy is frozen onto an audit when the audit finishes, so editing a policy later never changes an approval already in progress.

Built-in guardrails:

- Nobody can approve their own audit unless a policy allows it.
- One person can't fill two steps of the same audit.
- A report whose message trail or hash has changed can't be signed.
- The last administrator can't be removed.

## Tests

```bash
npm test                  # engine, LLM path, services, bundle, assistant, passkeys, program and chaos, invites, A2A protocol,
                          # cloud adapters, workspaces, evidence connectors (against local stand-ins for each service)
npm run test:pg           # service and workspace tests on Postgres (needs TEST_DATABASE_URL)
npm run test:e2e          # web + worker + Postgres, 28 end-to-end checks with a software passkey authenticator
CLOUD_E2E=1 npm run test:e2e   # the same with S3, KMS, Secrets Manager and OTLP served by tests/fakecloud.ts
```

## Docs

- [docs/cloud/](docs/cloud/README.md): AWS, Azure and Google Cloud with Terraform; the runtime contract in [configuration.md](docs/cloud/configuration.md)
- [docs/connectors.md](docs/connectors.md): evidence sources (Git, Jira, CI)
- [docs/deploy.md](docs/deploy.md): Compose, Kubernetes with KEDA, air-gapped installs, SSO setup
- [docs/operations.md](docs/operations.md): backups, upgrades, monitoring and alerts, key rotation, runbook
- [docs/security.md](docs/security.md): controls, threat model and what each defends against
- [docs/evidence-bundle.md](docs/evidence-bundle.md): the upload format, file by file
- [docs/api.md](docs/api.md): REST endpoints and CI usage with API tokens
- [docs/protocol.md](docs/protocol.md): the A2A protocol, with JSON Schemas in [docs/protocol/](docs/protocol/)
- [docs/judge-qa.md](docs/judge-qa.md): the hackathon Q&A, kept for the record

## Repository layout

```
lib/engine/   agents, A2A broker, Layer 1 rules, Layer 2 reader, orchestrator, synthetic generator (isomorphic)
lib/core/     domain model, approval policy engine, scheduler maths, services, evidence bundle, in-memory repo,
              workspace scoping, program readiness, chaos drills, passkeys (WebAuthn), invites
lib/testing/  software passkey authenticator and attestation certificates for tests and the demo
lib/server/   Postgres repo + migrations, auth, LLM providers, notifications, worker, CLI, API router, OpenTelemetry
  cloud/      object storage (S3, Blob, GCS), KMS signers, secret references, cloud tokens
  connectors/ GitHub, GitLab, Jira, CI artifacts, and the outbound-request guard
ui/           React app (server build and the single-file browser demo share it)
deploy/       Terraform for AWS, Azure and GCP; OpenTelemetry collector configs and alerts; Kubernetes (kustomize, KEDA)
docker/       entrypoint and healthcheck
tests/        unit, Postgres and end-to-end tests
```
