# Security controls

| Threat | Control | Where |
| --- | --- | --- |
| Stolen or phished password | No audit data opens until the person verifies with a passkey (fingerprint, face or PIN on their own device). Passkeys are bound to the site's domain, so a look-alike site can't use them. | `services.assertAccess`, `lib/core/webauthn.ts` |
| Someone at an unlocked laptop | Sensitive steps (evidence export, policy and access changes, tokens, settings) need a passkey check from the last few minutes; Approve and Deny need a fresh one every time | `services.stepUp`, `decisionProof` |
| "I didn't approve that" | Each decision is signed on the approver's own device over a challenge derived from the run, the action, the reason and the report hash. The assertion and public key go into the evidence package and verify offline with `scripts/verify-evidence.mjs`, independent of the server's key | `lib/core/passkeyProof.ts` |
| A replayed or reused passkey response | Each challenge is stored server-side, bound to the user and session, valid for 5 minutes and deleted on first use | `takeChallenge` |
| Someone enrols a passkey in another person's name | New people get a one-time invite link instead of a temporary password; password sign-ins can't enrol a first passkey (configurable) | `createInvite`, `firstEnrollAllowed` |
| A personal phone used for DER sign-off | Admins can list approved security-key models; a key must prove its model with a vendor certificate chained to a pinned root, so a forged claim fails | `finishPasskeyRegistration`, `tests/invite.test.ts` |
| A compromised CI token | Tokens can start audits but never pass a passkey check, so they can't approve, deny or touch anything sensitive | `stepUp`, `decisionProof` |
| Someone approves work they shouldn't | Approval authority comes only from policies: step groups, named people and delegations. Roles never grant it. | `lib/core/policy.ts` |
| Rubber-stamping your own audit | The requester can't sign unless a policy says so, and one person can't fill two steps | `evaluateApproval` |
| A policy changes mid-approval | The policy is frozen onto the run at completion, and its version is shown on every decision | `executeAudit` |
| A report changes after approval | Decisions are Ed25519 signatures over the report hash. The hash is recomputed before signing and in verification. | `services.decide`, `verifyRun`, `scripts/verify-evidence.mjs` |
| A forged or malformed agent message | An HMAC per agent, the sender checked against its key, a JSON schema per type, rejected messages kept in the trail | `lib/engine/broker.ts` |
| An LLM invents evidence | A Layer 2 finding counts only if the cited record exists and the quoted text is in it. It never affects the verdict otherwise. | `crossCheck` in `layer2.ts` |
| The assistant leaks or invents audit facts | It only reads runs the asker can view (same check as the API). Every sentence must cite a source. In LLM mode the model sees only numbered sources, and sentences with missing citations or IDs not in those sources are dropped; if nothing survives, the rule-based answer is used. Questions are audit-logged. | `lib/core/assistant.ts`, `services.ask` |
| Voice audio leaving the site | Set `STT_URL` to an on-prem transcription server; the microphone is limited to the app's own origin by Permissions-Policy | `api.ts` `/assistant/transcribe`, `next.config.mjs` |
| Prompt injection from code comments | The model is told repository text is data; Layer 2 can't call tools or change anything; the cross-check still applies | `lib/server/llm.ts` |
| History rewritten | Hash-chained audit log, plus a database trigger that refuses UPDATE, DELETE and TRUNCATE | migration 1 |
| Stolen session cookie used cross-site | httpOnly, SameSite=Lax and Secure cookies; mutating requests need a custom header a cross-site form can't send | `lib/server/http.ts` |
| Password guessing | scrypt (N=2^15) hashes, 5 failures per email and IP per 15 minutes, 12-character minimum, forced change of temporary passwords | `lib/server/crypto.ts`, `services.loginLocal` |
| Leaked API token | Only a SHA-256 of the token is stored, shown once at creation, expires within 365 days, can be revoked, last use recorded | `services.createToken` |
| Last admin removed by mistake | Any change that would leave no active administrator is refused and rolled back | `ensureAnAdmin` |
| Container breakout surface | Non-root UID 10001, read-only root filesystem, no capabilities, seccomp RuntimeDefault, no shell tools beyond the base image | `Dockerfile`, `deploy/k8s` |
| Clickjacking, XSS, sniffing | CSP with `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, a strict referrer policy, HSTS over https | `next.config.mjs` |
| One program reading another's data | Every record carries a workspace. Services only ever see a workspace-scoped store: lists are filtered, creates are stamped, and reading or changing another workspace's record behaves as not found. People are global; their roles are per workspace. The passkey policy is organisation-wide and only platform admins change it | `lib/core/scopedRepo.ts`, `tests/workspace.test.ts` (memory and Postgres) |
| Signing key stolen from the database or a backup | `SIGNER=aws-kms`, `azure-kv` or `gcp-kms` keeps the ES256 key in the cloud KMS or HSM. The app sends a digest and gets a signature; it never holds the private key. Old public keys stay listed at `/api/keys` | `lib/server/cloud/signers.ts` |
| Secrets in task definitions or Terraform | The app reads `*_REF` values (`aws-sm://`, `azure-kv://`, `gcp-sm://`) with its own cloud identity at start-up | `lib/server/cloud/secrets.ts` |
| An evidence source used to reach internal services (SSRF) | Connector URLs must be https; the resolved address is checked when the connection opens, so DNS tricks don't help; private, loopback and link-local addresses need an explicit `CONNECTOR_ALLOWED_HOSTS` entry; cloud metadata addresses are refused always; redirects are re-checked and drop the Authorization header when the host changes; responses are size- and time-capped | `lib/server/connectors/http.ts` |
| An evidence source used to exfiltrate the app's own secrets | A source names its tokens by reference, and only well-formed references (exact shape per store, no `..` segments) under `CONNECTOR_SECRET_PREFIXES` (default `env://CONNECTOR_`) are accepted, so a workspace admin can't point a token at the database password and send it to a server they control. Token values are never stored or logged | `secretRefProblem`, `tests/connectors.test.ts` |
| Evidence swapped between sync and audit | Each synced version stores the commit, baseline commit, Jira query and CI run it came from, plus a SHA-256 over every input file. The original bundle is kept in object storage | `Dataset.provenance` |
| Data leaving the site | No runtime calls except the ones you configure (SSO, LLM, webhooks). Fonts are self-hosted, and an on-prem LLM is supported. | `deploy.md` |

## Known limits, stated plainly

- The rule-based Layer 2 reader catches the patterns it was written for (vague wording, numeric threshold mismatches, interrupt handlers flagged as dead code). An LLM reader catches more, but it is advisory, and the cross-check keeps it honest.
- The C/Ada parser finds functions, trace tags and calls with patterns, not a full compiler front end. Macros that generate functions won't be seen. The import warnings say what was skipped.
- Signing keys stored in the database (the default with `SIGNER=local`) are only as safe as the database. Production should use `SIGNER=aws-kms`, `azure-kv` or `gcp-kms`.
- Connectors reach Git, Jira and CI directly. If your egress goes through an HTTP proxy, connectors don't use it yet; allow the hosts at the firewall instead.
- GitLab job artifacts are fetched by branch name, so they may come from a slightly older pipeline than the synced commit. The sync records a warning saying so. GitHub Actions results are matched to the exact commit.
- Without `STT_URL`, voice input uses the browser's built-in speech recognition. In Chrome that sends audio to Google's speech service. Sites that can't allow that should set `STT_URL` to an on-prem server, or leave voice off and type.
- The assistant's rule-based mode understands the question types listed in `lib/core/assistant.ts` and declines the rest. An LLM widens what it understands, not what it is allowed to claim.
- By default the first passkey comes from a one-time invite link (72 hours, single use, replaced by any newer link) or right after an SSO sign-in. Whoever holds an unused invite link can enrol, so send links over a channel you trust. "Only from an invite link" removes the SSO path too.
- The hardware allowlist trusts a device's model only through vendor attestation that chains to a root an administrator pinned. Revocation lists named in vendor certificates are fetched when present; an air-gapped site should pin roots whose certificates don't need online revocation checks.
- Passkey checks in the browser demo use a simulated device (keys in memory). The verification code is the real one; the device isn't.
- The application approves *audit reports*. It does not certify software. A DER's sign-off here records their judgement and does not replace it.
