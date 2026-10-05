// Chaos drills for the robustness criterion: real faults injected into real audits.
import type { AgentName, Fault } from '../engine/types';
export type ChaosPreset = 'testing-offline' | 'code-flaky' | 'forged-design' | 'storm';
/** Drills for the robustness criterion. Each one names what should happen, so the result can be checked against it. */
export const CHAOS_PRESETS: Record<ChaosPreset, { label: string; faults: Partial<Record<AgentName, Fault>>; expect: string }> = {
  'testing-offline': { label: 'Testing agent goes offline', faults: { Testing: 'offline' }, expect: 'Retries with backoff, then the breaker opens. The audit still finishes, marked incomplete, and the verdict cannot be YES.' },
  'code-flaky': { label: 'Code agent drops messages', faults: { Code: 'flaky' }, expect: 'Missed acknowledgements are retried. The agent recovers and the verdict matches a clean run.' },
  'forged-design': { label: 'Design agent sends forged messages', faults: { Design: 'malformed' }, expect: 'The broker rejects messages with bad signatures or schemas and keeps them in the trail as rejected.' },
  'storm': { label: 'Everything at once', faults: { Testing: 'offline', Code: 'flaky', Requirements: 'malformed' }, expect: 'Several agents degrade together. Breakers isolate the dead one, retries carry the flaky one, forged messages are rejected, and the orchestrator still reports a verdict.' },
};

/** After a drill: did the system behave as promised? Each check reads the finished audit, nothing else. */
export function checkDrill(faults: Partial<Record<string, Fault>>, r: { verdict: string; complete: boolean; chainValid: boolean; health: { agent: string; state: string; retries: number; breaker: string }[]; messages: { from: string; accepted: boolean }[] }) {
  const out: { label: string; ok: boolean; detail: string }[] = [];
  for (const [agent, f] of Object.entries(faults)) {
    if (!f || f === 'none') continue;
    const h = r.health.find(x => x.agent === agent);
    if (f === 'offline') out.push({ label: `${agent} offline: retried, then isolated`, ok: !!h && h.retries > 0 && h.state === 'offline' && h.breaker !== 'closed', detail: h ? `${h.retries} retries, breaker ${h.breaker}, state ${h.state}` : 'no health record' });
    if (f === 'flaky') out.push({ label: `${agent} flaky: retries carried it through`, ok: !!h && h.retries > 0 && h.state !== 'offline', detail: h ? `${h.retries} retries, ended ${h.state}` : 'no health record' });
    if (f === 'malformed') { const rej = r.messages.filter(m => m.from === agent && !m.accepted).length; out.push({ label: `${agent} forged messages: rejected by the broker`, ok: rej > 0, detail: `${rej} rejected, kept in the trail` }); }
  }
  const anyOffline = Object.values(faults).includes('offline');
  out.push({ label: 'Audit still finished with a verdict', ok: !!r.verdict, detail: `verdict ${r.verdict}` });
  if (anyOffline) out.push({ label: 'Incomplete audit cannot be YES', ok: !r.complete && r.verdict !== 'YES', detail: r.complete ? 'marked complete' : `marked incomplete, verdict ${r.verdict}` });
  out.push({ label: 'Message trail hash chain intact', ok: r.chainValid, detail: r.chainValid ? 'verified' : 'BROKEN' });
  return out;
}
