import { sha256, canonical } from '../engine/crypto';
import type { AuditEvent } from './model';

export function auditHash(e: Omit<AuditEvent, 'hash'>): Promise<string> {
  const { prevHash, ...rest } = e;
  return sha256(prevHash + canonical({ seq: rest.seq, at: rest.at, actorId: rest.actorId, actorName: rest.actorName, action: rest.action, target: rest.target, details: rest.details }));
}

export async function verifyAuditChain(events: AuditEvent[]): Promise<{ ok: boolean; checked: number; brokenAt?: number; reason?: string }> {
  let prev = 'GENESIS', lastSeq = 0;
  for (const e of events) {
    if (e.seq !== lastSeq + 1) return { ok: false, checked: lastSeq, brokenAt: e.seq, reason: `Event ${lastSeq + 1} is missing` };
    if (e.prevHash !== prev) return { ok: false, checked: lastSeq, brokenAt: e.seq, reason: `Event ${e.seq} does not link to event ${lastSeq}` };
    if ((await auditHash(e)) !== e.hash) return { ok: false, checked: lastSeq, brokenAt: e.seq, reason: `Event ${e.seq} was altered after it was written` };
    prev = e.hash; lastSeq = e.seq;
  }
  return { ok: true, checked: lastSeq };
}
