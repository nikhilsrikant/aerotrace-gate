# REST API

Base path `/api`. JSON in and out. Errors look like `{ "error": "plain sentence" }`, with the usual status codes and an `x-request-id` header.

**Auth.**
- Browser sessions use the `aero_session` cookie, and every non-GET request also needs the header `x-aerotrace-csrf: 1`.
- Scripts and CI use `Authorization: Bearer atg_…` (create one under **API tokens**). No CSRF header is needed with a token.
- A token has exactly the permissions of the person it belongs to, and belongs to one workspace.

**Workspaces.** Each program lives in its own workspace. A browser session works in the workspace it last switched to (`POST /workspaces/:id/switch`). Scripts can name one per request with the header `x-aerotrace-workspace: ws_…`; the caller must be a member. API tokens always act in the workspace they were created in.

## Start audits from CI

```bash
curl -sS -X POST https://aerotrace.example.com/api/runs \
  -H "Authorization: Bearer $AEROTRACE_TOKEN" -H 'content-type: application/json' \
  -d '{"datasetId":"ds_…","modules":["BARO-*"],"layer2":"auto"}'
# → {"runIds":["run_…"]}

curl -sS https://aerotrace.example.com/api/runs/run_… -H "Authorization: Bearer $AEROTRACE_TOKEN" | jq '.status, .verdict, .approval.waitingOn'
```

## Errors and passkeys

Errors are `{ "error": "...", "code": "..." }`. Codes the UI acts on: `passkey_enroll` and `passkey_required` (the session isn't unlocked yet), `step_up_required` (confirm with a passkey, then retry), `decision_passkey_required`, `passkey_person_only` (API tokens can't do this), `challenge_expired`.

## Endpoints

| Method | Path | Needs | Purpose |
| --- | --- | --- | --- |
| GET | /health, /ready, /metrics | none | Liveness, readiness, Prometheus |
| GET | /keys | none | `{ current, keys[] }`: the signing key in use and every key used before it (JWK, with `kid` and `alg`), so decisions signed before a key rotation or a move to KMS still verify |
| GET | /workspaces | signed in | `{ current, platformAdmin, workspaces[] }`: the workspaces you belong to (platform admins see all) |
| POST | /workspaces | platform admin | `{ name }` Creates a workspace with you as its admin, a Reviewers group and a one-reviewer policy |
| PATCH | /workspaces/:id | platform admin | `{ name }` |
| POST | /workspaces/:id/switch | member | Points this browser session at another workspace |
| GET | /auth/config | none | Which sign-in methods are on |
| POST | /auth/login | none | `{ email, password }` |
| POST | /auth/logout | session | |
| GET | /auth/me | session/token | Current user and permissions |
| POST | /auth/password | session | `{ current, next }` |
| GET | /auth/sso/start, /auth/sso/callback | none | OpenID Connect flow |
| POST | /auth/passkey/login/options, /auth/passkey/login | none | Passwordless sign-in: get WebAuthn options, then send `{ challengeId, response }` |
| POST | /auth/passkey/register/options, /auth/passkey/register | session | Enrol a passkey (first one right after password/SSO; more after a fresh check). Body `{ challengeId, response, name? }` |
| POST | /auth/passkey/verify/options, /auth/passkey/verify | session | Unlock the session or refresh the step-up window |
| GET / PATCH / DELETE | /auth/passkeys, /auth/passkeys/:id | session | Your passkeys: list, rename `{ name }`, remove (needs a fresh check) |
| POST | /users/:id/passkeys/reset | access.manage + fresh check | Lost device: remove all of someone's passkeys, sign them out, and return a fresh invite link |
| GET | /protocol | none | The A2A protocol spec: envelope and payload JSON Schemas, sender rules, signing, chaining |
| GET | /program | view | `?dataset=` Program readiness: verdict, every module, agent health, message flow, daily trends, ranked blockers, unblock plan |
| POST | /chaos | audit.request | `{ module, preset }` with preset `testing-offline`, `code-flaky`, `forged-design` or `storm`. Starts a real audit with those faults |
| POST | /users/:id/invite | access.manage + fresh check | `{ hours? }` → one-time invite link `{ url, token, expiresAt }` |
| POST | /auth/invite | none | `{ token }` Opens an invite link: a session that can only set up a passkey |
| GET | /meta, /directory | signed in | Version, LLM, signer; names for pickers |
| GET / POST | /datasets | view / dataset.manage | List; upload (multipart `file`, `name`) or `{ name, seed }` for synthetic |
| DELETE | /datasets/:id | dataset.manage | |
| GET | /sources | view | Evidence sources in this workspace, each with its last sync |
| POST | /sources | dataset.manage + fresh check | `{ name, git: { provider, baseUrl?, repo, ref, root?, baselineRef?, tokenRef? }, jira?, ci?, autoAudit? }`. Secrets are references only. See [connectors.md](connectors.md) |
| PUT / DELETE | /sources/:id | dataset.manage + fresh check | Update or remove (a schedule that syncs it must go first) |
| POST | /sources/:id/sync | dataset.manage | Queue a sync → `{ queued: true }`. The worker fetches, builds and imports; a sync with unchanged inputs records `unchanged` instead of a new version |
| POST | /sources/:id/test | dataset.manage | Dry run: fetch and import in memory, store nothing → `{ ok, commit, modules, total, warnings }` or `{ ok: false, error }` |
| GET | /datasets/sample | signed in | Sample evidence bundle zip |
| GET / POST | /runs | view / audit.request | List (`?status=awaiting_approval,approved`); start `{ datasetId, modules[], layer2, faults }` |
| GET | /inbox | signed in | `{ mine, others }`: audits you can sign now, and the rest |
| GET | /runs/:id | view, or eligible approver | Full report, approval state, decisions |
| POST | /runs/:id/decision/options | eligible approver | `{ action, reason? }` → WebAuthn options whose challenge is derived from this exact decision |
| POST | /runs/:id/decision | eligible approver | `{ action: "approve"\|"deny", reason?, passkey: { challengeId, response } }` |
| GET | /runs/:id/verify | view | Re-check trail, report hash and signatures |
| GET | /runs/:id/evidence | view | Evidence package (JSON) for offline verification |
| GET | /runs/:id/report | view | Markdown report |
| GET | /runs/:id/diff | view | New and resolved findings since the previous audit of the module |
| GET / POST | /schedules | view / schedule.manage | Recurrence: `{kind:"interval",everyMinutes}`, `{kind:"daily",time}`, `{kind:"weekly",days,time}`, `{kind:"cron",expr}` plus `timezone`. Give `sourceId` instead of `datasetId` to sync that source first and audit what it produced |
| PUT / DELETE | /schedules/:id | schedule.manage | |
| POST | /schedules/:id/run | schedule.manage | Run now |
| GET / POST | /policies | signed in / policy.manage | Approval policies |
| PUT / DELETE | /policies/:id | policy.manage | |
| POST | /policies/simulate | signed in | `{ datasetId, module, dal, verdict, requestedBy }` → who would sign |
| GET / POST | /delegations | signed in | Your own; others with delegation.manage |
| DELETE | /delegations/:id | owner or delegation.manage | Revoke |
| GET / POST | /users | access.manage | |
| PATCH | /users/:id | access.manage | `{ name, active, roleIds, groupIds, password }` |
| GET / POST / PUT / DELETE | /groups, /groups/:id | access.manage to change | Body may include `memberIds` |
| GET / POST / PUT / DELETE | /roles, /roles/:id | access.manage to change | |
| GET / POST / DELETE | /tokens, /tokens/:id | signed in | Token shown once on creation |
| GET / PUT | /settings | settings.manage to change | Org name, LLM, notifications |
| POST | /assistant | signed in | `{ question, runId?, timezone? }` → `{ sentences:[{text,cites[]}], citations[], mode, followUps[], proposal?, abstained? }`. Answers only from audits the caller can see |
| POST | /assistant/transcribe | signed in | Multipart `audio` (≤10 MB) → `{ text }`. Needs `STT_URL` |
| GET | /automation/suggestions | view | `?tz=` Audits someone keeps running by hand on a regular rhythm, with a proposed recurrence |
| POST | /automation/suggestions/dismiss | schedule.manage | `{ key }` hides a suggestion |
| GET | /audit-log, /audit-log/verify | auditlog.view | `?limit=&before=` |

## Sync evidence from CI after a merge

```bash
curl -sS -X POST https://aerotrace.example.com/api/sources/src_…/sync -H "Authorization: Bearer $AEROTRACE_TOKEN"
# → {"queued":true}; poll GET /api/sources for lastSync.status: ok | unchanged | failed
```

## Webhook payload (generic JSON)

```json
{ "event": "run.awaiting_approval", "runId": "run_…", "module": "BARO-IN", "dal": "A", "verdict": "NO",
  "status": "awaiting_approval", "link": "https://aerotrace.example.com/#run_…", "at": "2026-10-03T15:52:34Z",
  "approvers": ["Sid Quality"] }
```
