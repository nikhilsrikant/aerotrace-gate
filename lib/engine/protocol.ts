// The AeroTrace A2A protocol, published: versioned JSON Schemas for the envelope and every payload, plus a
// conformance check a new agent must pass before it joins the broker. The broker's validate() is the runtime
// enforcement; tests prove the two agree.
import type { A2AMessage, MsgType } from './types';
import { AGENTS } from './types';
import { validate } from './broker';
import { hmac, sha256, canonical } from './crypto';

export const PROTOCOL_VERSION = '1.0.0';
const ID = `https://aerotrace.example/a2a/${PROTOCOL_VERSION}`;
const SENDERS = ['Orchestrator', ...AGENTS] as const;
export const SENDER_TYPES: Record<string, MsgType[]> = Object.fromEntries(SENDERS.map(s => [s, s === 'Orchestrator' ? ['request', 'status', 'result', 'error'] : ['status', 'dependency', 'blocker', 'finding', 'heartbeat', 'result', 'error']]));

const nonEmpty = { type: 'string', minLength: 1 } as const;
export const PAYLOAD_SCHEMAS: Record<MsgType, Record<string, unknown>> = {
  request: { $id: `${ID}/payload/request.json`, title: 'Audit request from the Orchestrator', type: 'object', required: ['scope'], properties: { scope: { ...nonEmpty, description: 'Module ID being audited' }, dal: { enum: ['A', 'B', 'C', 'D', 'E'] }, baseline: { type: 'string' }, layers: { type: 'array', items: { enum: ['L1', 'L2'] } }, requestedBy: { type: 'string' } } },
  status: { $id: `${ID}/payload/status.json`, title: 'Progress or state change', type: 'object', required: ['text'], properties: { text: nonEmpty, dispute: { type: 'string', description: 'Finding ID this status disputes' } } },
  error: { $id: `${ID}/payload/error.json`, title: 'Agent error', type: 'object', required: ['text'], properties: { text: nonEmpty } },
  finding: { $id: `${ID}/payload/finding.json`, title: 'A defect, with the evidence that supports it', type: 'object', required: ['title', 'severity', 'citations'],
    properties: { id: { type: 'string' }, layer: { enum: ['L1', 'L2'] }, title: nonEmpty, severity: { enum: [1, 2, 3], description: '1 blocks certification' }, objective: { type: 'string', description: 'DO-178C objective, e.g. Table A-7' }, ref: { type: 'string' },
      citations: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Paths of the evidence records; a finding without a source is rejected' } } },
  dependency: { $id: `${ID}/payload/dependency.json`, title: 'One agent needs another agent\'s output', type: 'object', required: ['needs', 'on'], properties: { needs: nonEmpty, on: { enum: [...AGENTS] } } },
  blocker: { $id: `${ID}/payload/blocker.json`, title: 'A finding that blocks another agent\'s objectives', type: 'object', required: ['ref', 'impact'], properties: { ref: nonEmpty, impact: nonEmpty, findings: { type: 'array', items: { type: 'string' } } } },
  heartbeat: { $id: `${ID}/payload/heartbeat.json`, title: 'Liveness', type: 'object', properties: { attempt: { type: 'integer', minimum: 1 }, done: { type: 'boolean' } } },
  result: { $id: `${ID}/payload/result.json`, title: 'Work finished', type: 'object', required: ['count'], properties: { count: { type: 'number', minimum: 0 }, l1: { type: 'number' }, l2: { type: 'number' }, verdict: { enum: ['YES', 'NO', 'CONDITIONAL'] } } },
};

export const ENVELOPE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `${ID}/envelope.json`, title: `AeroTrace A2A message envelope v${PROTOCOL_VERSION}`,
  type: 'object', required: ['id', 'ts', 'from', 'to', 'subject', 'type', 'correlationId', 'payload', 'sig'],
  properties: {
    id: { type: 'string', pattern: '^msg_[0-9]{6,}$' }, ts: { type: 'integer', description: 'Unix epoch milliseconds' },
    from: { enum: [...SENDERS] }, to: { enum: [...SENDERS, '*'], description: '"*" broadcasts to every subscriber except the sender' },
    subject: { type: 'string', pattern: '^audit\\.[A-Za-z0-9_-]+\\.(orchestrator|requirements|design|code|testing|configmgmt)\\.(request|status|dependency|blocker|finding|heartbeat|result|error)$', description: 'audit.<runId>.<sender>.<type>' },
    type: { enum: Object.keys(PAYLOAD_SCHEMAS) }, correlationId: nonEmpty, payload: { type: 'object' }, latencyMs: { type: 'number' },
    sig: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'HMAC-SHA256, hex, with the sender\'s key, over canonical JSON of the envelope minus sig, prevHash, hash, accepted and reason' },
    prevHash: { type: 'string' }, hash: { type: 'string', description: 'sha256(prevHash + canonical({...envelope, accepted, reason}))' }, accepted: { type: 'boolean' }, reason: { type: 'string' },
  },
  allOf: (Object.keys(PAYLOAD_SCHEMAS) as MsgType[]).map(t => ({ if: { properties: { type: { const: t } } }, then: { properties: { payload: { $ref: (PAYLOAD_SCHEMAS[t] as { $id: string }).$id } } } })),
};

/** The whole spec as one document: what /api/protocol serves and docs/protocol/ holds. */
export function protocolSpec() {
  return {
    name: 'AeroTrace A2A', version: PROTOCOL_VERSION, envelope: ENVELOPE_SCHEMA, payloads: PAYLOAD_SCHEMAS, senders: SENDER_TYPES,
    routing: 'Subject audit.<runId>.<sender>.<type>. "to" names one receiver, or "*" for every subscriber except the sender. Only accepted messages are delivered.',
    signing: 'Each agent has its own key. sig = HMAC-SHA256(key, canonical(envelope without sig/prevHash/hash/accepted/reason)). The broker recomputes it with the key registered for "from"; a mismatch is rejected.',
    chain: 'Every message, accepted or rejected, is appended under a lock: hash = sha256(prevHash + canonical({...envelope, sig, accepted, reason})), starting from "GENESIS".',
    rejection: 'Rejected messages stay in the trail with accepted=false and a reason, so auditors see what was refused.',
    versioning: 'Semantic versioning. Adding an optional payload field is a minor change; adding a required field, a message type rule or changing signing is a major change and needs a new broker release.',
    canonicalJson: 'Object keys sorted, no whitespace, undefined fields dropped.',
  };
}

export interface ConformanceResult { ok: boolean; checked: number; problems: { index: number; id?: string; problem: string }[] }
/**
 * Before a new agent joins: run it against a test audit, collect what it sends, and check every message.
 * Envelope and payload schemas, allowed message types for that sender, subject format, signature with its key,
 * and agreement with the broker's own validator.
 */
export async function checkConformance(messages: unknown[], agent: string, key: string, schemaCheck: (m: unknown) => string | null): Promise<ConformanceResult> {
  const problems: ConformanceResult['problems'] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as A2AMessage; const id = (m as { id?: string })?.id;
    const bad = (problem: string) => problems.push({ index: i, id, problem });
    const s = schemaCheck(m); if (s) { bad(`schema: ${s}`); continue; }
    if (m.from !== agent) bad(`sent as "${m.from}", but this agent is "${agent}"`);
    if (!SENDER_TYPES[m.from]?.includes(m.type)) bad(`"${m.from}" may not send "${m.type}"`);
    if (!m.subject.endsWith(`.${m.from.toLowerCase()}.${m.type}`)) bad('subject does not match sender and type');
    const { sig, prevHash: _p, hash: _h, accepted: _a, reason: _r, ...body } = m; void _p; void _h; void _a; void _r;
    if ((await hmac(key, canonical(body))) !== sig) bad('signature does not verify with the agent\'s key');
    const v = validate(m); if (v) bad(`broker would reject: ${v}`);
  }
  return { ok: problems.length === 0, checked: messages.length, problems };
}

/** Recompute a trail's hash chain (what verify-evidence.mjs does offline). */
export async function verifyTrail(messages: A2AMessage[]) {
  let prev = 'GENESIS';
  for (const m of messages) { const { hash, prevHash, sig, accepted, reason, ...body } = m; if (prevHash !== prev || (await sha256(prev + canonical({ ...body, sig, accepted, reason }))) !== hash) return false; prev = hash; }
  return true;
}
