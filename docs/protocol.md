# AeroTrace A2A protocol, v1.0.0

This is how the six AeroTrace agents talk to each other: the Orchestrator plus five audit agents (Requirements, Design, Code, Testing, Config Mgmt). Every message goes through the broker. The broker checks who sent it, checks it against the schema, routes it, and appends it to a hash-chained trail. Rejected messages stay in the trail too, so an auditor can see what was refused and why.

The machine-readable version is in [`docs/protocol/`](protocol/) (JSON Schema 2020-12). A running server also serves it at `GET /api/protocol`. Regenerate the files with `npm run protocol`. `tests/protocol.test.ts` fails if the published schemas and the broker ever disagree.

## Envelope

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `msg_000123` | Unique within the process |
| `ts` | integer | Unix epoch milliseconds |
| `from` | sender | `Orchestrator`, `Requirements`, `Design`, `Code`, `Testing`, `ConfigMgmt` |
| `to` | sender or `*` | One receiver, or `*` for everyone subscribed except the sender |
| `subject` | string | `audit.<runId>.<sender>.<type>`, lower-case sender |
| `type` | message type | See below |
| `correlationId` | string | Ties every message of one audit together |
| `payload` | object | Checked against the schema for `type` |
| `sig` | hex | HMAC-SHA256 with the sender's own key over the canonical JSON of the envelope (without `sig`, `prevHash`, `hash`, `accepted`, `reason`) |
| `prevHash`, `hash` | hex | Chain link: `hash = sha256(prevHash + canonical({...envelope, sig, accepted, reason}))`, starting from `GENESIS` |
| `accepted`, `reason` | | Set by the broker. `accepted=false` messages are kept but never delivered |

Canonical JSON means keys sorted, no whitespace, and undefined fields dropped.

## Message types

| Type | Who may send it | Required payload | Purpose |
| --- | --- | --- | --- |
| `request` | Orchestrator | `scope` | Start an audit of one module |
| `status` | everyone | `text` | Progress, state changes, disputes (`dispute: <findingId>`) |
| `error` | everyone | `text` | Something went wrong |
| `finding` | agents | `title`, `severity` (1, 2 or 3), `citations` (at least one) | A defect, with the evidence records that show it. No source, no finding |
| `dependency` | agents | `needs`, `on` | "I need this from that agent" |
| `blocker` | agents | `ref`, `impact` | A finding that stops another agent's objectives. The Orchestrator builds the critical path from these |
| `heartbeat` | agents | none | Liveness. Missing heartbeats and acknowledgements drive retries and circuit breakers |
| `result` | everyone | `count` | Work finished |

## Authorisation

Each agent gets its own key when an audit starts. The broker recomputes `sig` with the key registered for `from`. A message signed with one agent's key while claiming to be another is rejected ("signature does not match Testing's key"). Agents may only send the types listed above for them.

## Robustness rules (what the Orchestrator does with this)

- An agent must acknowledge within the timeout. Otherwise it is retried, up to 3 attempts with backoff.
- After repeated failures its circuit breaker opens and it is marked offline. The audit still finishes, marked incomplete, and an incomplete audit can never be YES.
- Forged or malformed messages are rejected and logged. They never change the verdict.

You can watch all of this with the chaos drills on the Program readiness page.

## Adding a new agent: conformance

1. Give the agent its key and run it against a test audit.
2. Save the messages it sends as JSON.
3. Run `aerotrace a2a-conformance messages.json --agent <Name> --key <key>`.

The check covers the envelope and payload schemas, the allowed types for that sender, the subject format, the signature, and agreement with the broker's own validator. It prints each problem with the message index and exits non-zero on failure.

## Versioning

The protocol uses semantic versioning:
- **Minor:** adding an optional payload field.
- **Major, needing a new broker release:** adding a required field, changing who may send what, or changing signing or chaining.
