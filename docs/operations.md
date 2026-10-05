# Operating AeroTrace Gate

## Health and monitoring

| Endpoint | What it tells you |
| --- | --- |
| `GET /api/health` (web) | The process is up. Use it for liveness. |
| `GET /api/ready` (web) | The database answers. Use it for readiness. |
| `GET /healthz` on :9464 (worker) | The scheduler loop ran recently |
| `GET /api/metrics` (web) | Runs by status and verdict, queue depth, oldest pending approval, overdue schedules |
| `GET /metrics` on :9464 (worker) | Jobs finished, failed and retried, busy slots, job time, schedules fired, jobs reaped |

`deploy/monitoring/alerts.yml` has the rules to start with:
- queue backlog
- no workers
- overdue schedules
- approvals waiting more than 3 days
- failed runs

The Grafana dashboard sits next to it.

Logs are one JSON object per line, with `ts`, `level`, `msg`, `service`, plus a request id (`rid`) on API errors. The same id goes back to the caller in the `x-request-id` header, so a user's error message leads you straight to the log line.

## Backups

All state lives in Postgres. Back it up the way you back up any system of record.

```bash
pg_dump --format=custom --file=aerotrace-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" aerotrace-2026-10-03.dump
```

After a restore, run `aerotrace verify-audit-log`. If the chain checks out, nothing in the log was lost or edited.

Keep `SIGNING_PRIVATE_KEY` in your secret manager, not only in the database. Without the key, old signatures still verify against the public key, but nothing new can be signed with the same identity.

## Upgrades

1. Back up the database.
2. Run `aerotrace migrate` with the new image. Migrations are forward-only and wrapped in a transaction.
3. Roll out web, then workers. Workers finish their current job on SIGTERM (up to `WORKER_SHUTDOWN_GRACE_MS`). Anything interrupted is requeued by the stale-job reaper.

## Rotating the signing key

With a cloud KMS (`SIGNER=aws-kms`, `azure-kv` or `gcp-kms`): create a new key version or key in the KMS, point `SIGNER_*` at it, and roll web. The app adds the new public key to its history on first start; `GET /api/keys` keeps listing the old ones, so earlier evidence packages still verify.

With the built-in key:

1. Generate a new key: `openssl genpkey -algorithm ed25519 -out signing.pem`
2. Publish the **old** public key (from `GET /api/keys`) wherever auditors look, because existing evidence packages reference it by `keyId`.
3. Set `SIGNING_PRIVATE_KEY` to the new PEM and restart web.

## Runbook

| Symptom | Check | Fix |
| --- | --- | --- |
| Audits stay "Waiting for a worker" | `aerotrace_queue_jobs{status="ready"}`, worker pods | Start or scale workers, and check that workers can reach the DB |
| An audit failed | Run page shows the error; worker logs show `job failed` with attempts | Jobs retry 3 times with backoff. Fix the cause (for example the LLM endpoint) and start the audit again |
| Nobody can approve an audit | Run page → Approval → "Can sign: nobody right now" | Add people to that step's group, or fix the policy. Use the simulator on the policies page |
| "No approval policy covers this audit" | Policies page simulator | Add a policy, or widen the default one. Pending audits pick it up without re-running |
| Schedule didn't run | Schedules page shows "Last attempt" errors | Usually the owner was disabled or lost "start audits". Edit the schedule or the owner's roles |
| Locked out of all admin accounts | | `docker compose run --rm migrate create-admin --email you@x --password '…'` |
| Someone lost their passkey device | Users, groups, roles → Passkeys column | *Reset passkeys* on that person; they enrol a new one at next sign-in |
| The only administrator lost their passkey | | `aerotrace reset-passkeys --email …` (break-glass, audit-logged) |
| "Passkeys aren't offered" in the browser | The address bar shows https and the configured host | Serve over HTTPS on the hostname in `RP_ID`; add other URLs to `RP_ORIGINS` |
| Forgotten local password | | `aerotrace reset-password --email … --password …` (forces a change at next sign-in) |
| An evidence source shows *Failed* | Evidence datasets → the source's last sync; audit log `source.sync_failed` | The message names the service and status. 401: the token reference or token is wrong. 403: the token lacks read access. "resolves to a private address": add the host to `CONNECTOR_ALLOWED_HOSTS`. "outside the secrets connectors may read": store the token under `CONNECTOR_SECRET_PREFIXES` |
| Tampering suspected | `aerotrace verify-audit-log`; Run page → Verify and export | The output names the first broken event. Restore from backup and investigate |

## Data retention

Runs, decisions and the audit log are kept indefinitely by default, which suits DO-178C record keeping. The audit log can't be deleted from the application or by its database role. Archive the old ones with `pg_dump` and keep them according to your records policy.
