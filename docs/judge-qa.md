# Judge Q&A: AeroTrace Gate (PS 1.2, Avionics Audit Agents)

Short answers to the questions we expect. Every number here comes from the test suite in this repo.

## What's real and what's simulated?

**Real:**
- the five agents, the broker, signatures, the hash chains, retries and breakers;
- the verdict rule, approvals, passkey checks, the database, workers and containers.

**Simulated:**
- **The evidence.** It's a synthetic 50,000-record DO-178C program with planted defects, because no real program data was provided. You can upload a real evidence bundle (requirements CSV, C/Ada source, JUnit, coverage, baseline checksums, problem reports), and the agents audit it the same way.
- **The passkey device in the browser demo.** It's a labelled stand-in. The verification behind it is the production code. In real Chromium we used its built-in test authenticator for enrolment and passwordless sign-in.

## How good are the agents?

On the planted defects, the rule layer catches 1405 of 1408 (99.8%). The second layer reads requirement text and code for problems rules miss: vague "shall" wording, thresholds that disagree between requirement and code, and interrupt handlers wrongly flagged as dead code.

## Couldn't an LLM just make findings up?

It can't get one through.
- A Layer 2 finding only counts if the record it cites exists and the quoted words are actually in it.
- The broker rejects any finding with no citation.
- The verdict comes from a fixed rule, never from the model: any open severity-1 finding means NO; other findings mean CONDITIONAL; an agent that went offline means the audit can't be YES.

## How do the agents talk? (criterion 1)

Through a published protocol: JSON Schemas for the envelope and all eight message types, at `/api/protocol` and in `docs/protocol/`.
- Each agent signs with its own key, and the broker checks the sender.
- Every message, accepted or rejected, goes into a hash chain.
- A test proves the published schemas and the broker agree.
- A new agent runs `aerotrace a2a-conformance` before it can join.

## What does the orchestrator add? (criterion 2)

Per audit, it builds the critical path from blocker messages and ranks next actions by owner. Across the whole program, it ranks every blocker on one list and works out the fewest teams that would unblock the most modules. On the demo data, no one or two teams can flip a NO module on their own. CM, Test and Software leads together turn all 13 NO modules into CONDITIONAL.

## What happens when an agent dies? (criterion 3)

Press a chaos drill and watch. When Testing goes offline:
1. It is retried with backoff.
2. Its circuit breaker opens.
3. The audit still finishes, marked incomplete, and can't be YES.

Forged messages are rejected and kept in the trail. A worker that dies mid-job is detected and its job requeued. The report shows a pass/fail scorecard for each drill.

## Where's the dashboard? (criterion 4)

The Program readiness page shows:
- the program verdict and all 40 modules by DAL;
- agent health and p95 latency per audit;
- the message-flow matrix;
- retries and verdicts per day.

Each audit also has its own health, trail, latency and verdict view.

## Who's allowed to approve?

Whoever the program's approval policies say, not a hard-coded role. Policies match on dataset, module, DAL and verdict. Each lists the steps, the people or groups for each step, how many signatures are needed, and in what order. Delegation covers leave. One person can't sign two steps.

## How do you know the approval is genuine?

Every Approve or Deny is signed twice:
- by the approver's passkey on their own device, over the exact report hash;
- by the gate's Ed25519 key.

`scripts/verify-evidence.mjs` checks both offline, with no access to our server. Swap in another approver's key and the check fails.

## Why passkeys?

Engineers handle sensitive data, so a password alone opens nothing. Passkeys can't be phished on a look-alike site and need a fingerprint, face or PIN. New people get a one-time invite link, not a temporary password. Admins can limit enrolment to company-issued security keys, which must prove their model with a vendor certificate. A lost phone means an admin reset plus a new invite.

## Can it run air-gapped?

Yes.
- **Containers:** one image runs the web, worker and migrate roles, non-root with a read-only filesystem.
- **Data:** everything lives in Postgres.
- **Optional LLM:** can be an on-prem model.
- **Voice:** can use an on-prem Whisper server.
- **Fonts:** self-hosted.

There are Kubernetes manifests with queue-based autoscaling.

## Does this certify software?

No. It audits evidence and records a human decision with proof. A DER still makes the call.

## What's not finished?

- The C/Ada parser uses patterns, not a full compiler front end.
- Signing keys default to the database (production should use a KMS).
- The rule-based reader only knows the patterns it was written for.
- We haven't run against a real customer program or a live identity provider.
