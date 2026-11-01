// A2A broker: every agent message is signed, schema-checked, routed by subject and hash-chained.
// Rejected messages are kept in the trail too, so an auditor sees what was refused and why.
import type { A2AMessage, AgentName, MsgType, AuditEvent } from './types';
import { hmac, sha256, canonical } from './crypto';

type Sender = AgentName | 'Orchestrator';
type Handler = (m: A2AMessage) => Promise<void> | void;

const AGENT_TYPES: MsgType[] = ['status', 'dependency', 'blocker', 'finding', 'heartbeat', 'result', 'error'];
const ALLOWED: Record<string, MsgType[]> = { Orchestrator: ['request', 'status', 'result', 'error'] };

export function validate(m: Pick<A2AMessage, 'from' | 'to' | 'type' | 'payload'>): string | null {
  const allowed = ALLOWED[m.from] ?? AGENT_TYPES;
  if (!allowed.includes(m.type)) return `${m.from} is not allowed to send "${m.type}" messages`;
  const p = m.payload ?? {};
  const str = (k: string) => typeof p[k] === 'string' && (p[k] as string).length > 0;
  switch (m.type) {
    case 'request': return str('scope') ? null : 'request.scope is required';
    case 'status': case 'error': return str('text') ? null : `${m.type}.text is required`;
    case 'finding':
      if (!str('title')) return 'finding.title is required';
      if (![1, 2, 3].includes(p.severity as number)) return 'finding.severity must be 1, 2 or 3';
      if (!Array.isArray(p.citations) || !(p.citations as unknown[]).length) return 'finding.citations must list at least one source';
      return null;
    case 'dependency': return str('needs') && str('on') ? null : 'dependency.needs and dependency.on are required';
    case 'blocker': return str('ref') && str('impact') ? null : 'blocker.ref and blocker.impact are required';
    case 'result': return typeof p.count === 'number' ? null : 'result.count is required';
    case 'heartbeat': return null;
  }
  return 'unknown message type';
}

let msgSeq = 0;
export class Broker {
  messages: A2AMessage[] = [];
  private last = 'GENESIS';
  private lock: Promise<unknown> = Promise.resolve();
  private handlers = new Map<Sender, Handler>();
  private lastFrom = new Map<Sender, number>();
  latencies = new Map<Sender, number[]>();
  constructor(private runId: string, private keys: Record<Sender, string>, private emit?: (e: AuditEvent) => void, private pace = 0) {}

  subscribe(agent: Sender, h: Handler) { this.handlers.set(agent, h); }
  unsubscribe(agent: Sender) { this.handlers.delete(agent); }

  async publish(claimedFrom: Sender, signingKey: string, msg: { to: A2AMessage['to']; type: MsgType; payload: Record<string, unknown>; correlationId: string }) {
    const now = Date.now();
    const prev = this.lastFrom.get(claimedFrom) ?? now;
    this.lastFrom.set(claimedFrom, now);
    msgSeq += 1;
    const body = {
      id: `msg_${String(msgSeq).padStart(6, '0')}`, ts: now, from: claimedFrom, to: msg.to,
      subject: `audit.${this.runId}.${claimedFrom.toLowerCase()}.${msg.type}`, type: msg.type,
      correlationId: msg.correlationId, payload: msg.payload, latencyMs: Math.max(1, now - prev),
    };
    const sig = await hmac(signingKey, canonical(body));
    let accepted = true; let reason: string | undefined;
    const expected = this.keys[claimedFrom];
    if (!expected || (await hmac(expected, canonical(body))) !== sig) { accepted = false; reason = `signature does not match ${claimedFrom}'s key` }
    else { const err = validate(body); if (err) { accepted = false; reason = err } }
    // Append under a lock so concurrent agents can never fork the hash chain.
    const step = this.lock.then(async (): Promise<A2AMessage> => {
      const prevHash = this.last;
      const hash = await sha256(prevHash + canonical({ ...body, sig, accepted, reason }));
      this.last = hash;
      const msg: A2AMessage = { ...body, sig, prevHash, hash, accepted, reason };
      this.messages.push(msg);
      return msg;
    });
    this.lock = step;
    const m = await step;
    const lat = this.latencies.get(claimedFrom) ?? []; lat.push(body.latencyMs); this.latencies.set(claimedFrom, lat);
    this.emit?.({ kind: 'message', message: m });
    if (this.pace) await new Promise(r => setTimeout(r, this.pace));
    if (accepted) {
      if (m.to === '*') { for (const [a, h] of this.handlers) if (a !== claimedFrom) await h(m); }
      else { const h = this.handlers.get(m.to); if (h) await h(m); }
    }
    return m;
  }

  get tail() { return this.last; }
}

export async function verifyChain(messages: A2AMessage[]): Promise<boolean> {
  let prev = 'GENESIS';
  for (const m of messages) {
    const { hash, prevHash, ...rest } = m;
    if (prevHash !== prev) return false;
    const { sig, accepted, reason, ...body } = rest;
    if ((await sha256(prev + canonical({ ...body, sig, accepted, reason }))) !== hash) return false;
    prev = hash;
  }
  return true;
}
