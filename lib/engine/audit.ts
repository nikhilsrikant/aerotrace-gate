// Orchestrator: dispatches the five agents through the broker, keeps them alive with timeouts,
// retries and circuit breakers, cross-checks Layer 2, and computes the verdict a human then approves or denies.
import type {
  Corpus, AuditOptions, AuditRun, AgentName, Finding, AgentHealth, AuditEvent, LLMClient, Fault,
  CriticalStep, NextAction, Verdict, A2AMessage, Severity,
} from './types';
import { AGENTS } from './types';
import { telemetry } from './telemetry';
import { Broker, verifyChain } from './broker';
import { buildIndex, layer1, resetFindingIds, type Index } from './layer1';
import { l2Requirements, l2Code, crossCheck } from './layer2';
import { sha256, canonical, randomId } from './crypto';

export interface EngineOptions {
  llm?: LLMClient | null; onEvent?: (e: AuditEvent) => void; pace?: number;
  ackTimeoutMs?: number; workTimeoutMs?: number; retries?: number; runId?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
class TimeoutError extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`${what} timed out after ${ms} ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
const p95 = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

interface AgentCtx {
  agent: AgentName; c: Corpus; idx: Index; module: string; broker: Broker; key: string; corr: string;
  llm: LLMClient | null; attempt: number; fault: Fault; ack: () => void; shared: Shared;
}
interface Shared { findings: Map<AgentName, Finding[]>; disputes: { findingId: string; reason: string; quote: string }[]; llmCalls: number }

async function sendFinding(ctx: AgentCtx, f: Finding) {
  await ctx.broker.publish(ctx.agent, ctx.key, { to: 'Orchestrator', type: 'finding', correlationId: ctx.corr,
    payload: { id: f.id, layer: f.layer, title: f.title, severity: f.severity, objective: f.objective, ref: f.ref, citations: f.citations.map(c => c.path) } });
}

async function runAgent(ctx: AgentCtx): Promise<Finding[]> {
  const { agent, fault, attempt } = ctx;
  if (fault === 'offline') return new Promise(() => {});            // never answers; the timeout decides
  if (fault === 'flaky' && attempt === 1) throw new Error('connection reset by peer');
  if (fault === 'flaky' && attempt === 2) return new Promise(() => {});
  ctx.ack();
  const pub = (type: A2AMessage['type'], payload: Record<string, unknown>, to: A2AMessage['to'] = 'Orchestrator') =>
    ctx.broker.publish(agent, ctx.key, { to, type, payload, correlationId: ctx.corr });
  await pub('heartbeat', { attempt });
  const s = ctx.idx.byModule.get(ctx.module)!;
  const scopeText: Record<AgentName, string> = {
    Requirements: `checking ${s.hlrs.length} HLRs and ${s.llrs.length} LLRs`, Design: `checking couplings across ${s.fns.length} functions and ${s.design.length} design records`,
    Code: `checking traceability of ${s.fns.length} functions`, Testing: `checking ${s.tests.length} tests and coverage for DAL ${s.module.dal}`,
    ConfigMgmt: `checking ${s.cm.length} files against baseline ${ctx.c.baseline} and ${s.prs.length} problem reports`,
  };
  await pub('status', { text: `Layer 1: ${scopeText[agent]}` });
  const l1 = layer1(agent, ctx.c, ctx.idx, ctx.module);
  for (const f of l1) await sendFinding(ctx, f);
  let l2: Finding[] = [];
  if (agent === 'Requirements' || agent === 'Code') {
    await pub('status', { text: `Layer 2: semantic review (${ctx.llm ? 'LLM' : 'rule-based reader'})` });
    const r = agent === 'Requirements'
      ? await l2Requirements(ctx.c, ctx.idx, ctx.module, ctx.llm)
      : await l2Code(ctx.c, ctx.idx, ctx.module, l1.filter(f => f.kind === 'DEAD_CODE'), ctx.llm);
    l2 = r.findings; ctx.shared.llmCalls += r.llmCalls; ctx.shared.disputes.push(...r.disputes);
    if (fault === 'malformed') await forge(ctx, agent, l2[0] ?? l1[0]);
    for (const f of l2) await sendFinding(ctx, f);
    for (const d of r.disputes) await pub('status', { text: `Disputes ${d.findingId}: ${d.reason}`, dispute: d.findingId });
  }
  if (fault === 'malformed' && agent !== 'Requirements' && agent !== 'Code') await forge(ctx, agent, l1[0]);
  await pub('heartbeat', { attempt, done: true });
  await pub('result', { count: l1.length + l2.length, l1: l1.length, l2: l2.length });
  return [...l1, ...l2];
}

export async function runAudit(c: Corpus, opts: AuditOptions, eng: EngineOptions = {}): Promise<AuditRun> {
  resetFindingIds();
  const t0 = Date.now();
  const idx = buildIndex(c);
  const mod = c.modules.find(m => m.id === opts.module);
  if (!mod) throw new Error(`Unknown module ${opts.module}`);
  const llm = eng.llm && eng.llm.available && opts.layer2 !== 'heuristic' ? eng.llm : null;
  if (opts.layer2 === 'llm' && !llm) throw new Error('Layer 2 was set to LLM, but no LLM is configured. Set ANTHROPIC_API_KEY or choose auto.');
  const runId = eng.runId ?? randomId('run');
  const corr = runId;
  const keys = Object.fromEntries(['Orchestrator', ...AGENTS].map(a => [a, `${runId}:${a}:${Math.random().toString(36).slice(2)}`])) as Record<AgentName | 'Orchestrator', string>;
  const broker = new Broker(runId, keys, eng.onEvent, eng.pace ?? 0);
  const ackTimeout = eng.ackTimeoutMs ?? 1200, workTimeout = eng.workTimeoutMs ?? 50000, retries = eng.retries ?? 3;
  const phase = (text: string) => eng.onEvent?.({ kind: 'phase', text });
  const orch = (type: A2AMessage['type'], payload: Record<string, unknown>, to: A2AMessage['to'] = '*') =>
    broker.publish('Orchestrator', keys.Orchestrator, { to, type, payload, correlationId: corr });

  const health = new Map<AgentName | 'Orchestrator', AgentHealth>();
  ['Orchestrator', ...AGENTS].forEach(a => health.set(a as AgentName, { agent: a as AgentName, state: 'healthy', attempts: 0, retries: 0, failures: 0, breaker: 'closed', p95Ms: 0, lastHeartbeat: Date.now(), messages: 0 }));
  const pushHealth = () => {
    for (const [a, lat] of broker.latencies) { const h = health.get(a as AgentName); if (h) { h.p95Ms = p95(lat); h.messages = lat.length; } }
    eng.onEvent?.({ kind: 'health', health: [...health.values()].map(h => ({ ...h })) });
  };
  const shared: Shared = { findings: new Map(), disputes: [], llmCalls: 0 };
  const online = new Set<AgentName>();

  // Agents answer each other's dependency requests through the broker.
  const blockers: { from: AgentName; to: AgentName; findings: string[]; impact: string }[] = [];
  for (const a of AGENTS) broker.subscribe(a, async m => {
    if (m.type === 'blocker') blockers.push({ from: m.from as AgentName, to: a, findings: (m.payload.findings as string[]) ?? [], impact: String(m.payload.impact) });
    if (m.type !== 'dependency' || !online.has(a)) return;
    const mine = shared.findings.get(a) ?? [];
    const pub = (type: A2AMessage['type'], payload: Record<string, unknown>) => broker.publish(a, keys[a], { to: m.from, type, payload, correlationId: corr });
    if (a === 'Requirements') {
      const gaps = mine.filter(f => f.kind === 'HLR_NO_LLR' || f.kind === 'LLR_ORPHAN');
      if (gaps.length) await pub('blocker', { ref: gaps.map(g => g.ref).slice(0, 6).join(', '), impact: `${gaps.length} requirement gaps, so tests cannot be written for them yet`, findings: gaps.map(g => g.id) });
      else await pub('status', { text: 'Requirement set is complete for this module' });
    }
    if (a === 'ConfigMgmt') {
      const bad = mine.filter(f => f.kind === 'CHECKSUM_MISMATCH' || (f.kind === 'OPEN_PR' && f.severity === 1));
      if (bad.length) await pub('blocker', { ref: bad.map(g => g.ref).slice(0, 6).join(', '), impact: 'Test results on these files do not apply to the baseline until they are re-baselined and re-tested', findings: bad.map(g => g.id) });
      else await pub('status', { text: `All files match baseline ${c.baseline}; no blocking problem reports` });
    }
    if (a === 'Code') await pub('status', { text: `Call graph ready: ${idx.byModule.get(opts.module)!.fns.length} functions, cross-module calls listed` });
  });
  broker.subscribe('Orchestrator', m => { const h = health.get(m.from as AgentName); if (h) h.lastHeartbeat = Date.now(); });

  phase('Dispatching audit request');
  await orch('request', { scope: opts.module, dal: mod.dal, baseline: c.baseline, layers: ['L1', 'L2'], requestedBy: opts.requestedBy ?? 'unknown' });

  phase('Agents running Layer 1 and Layer 2');
  await Promise.all(AGENTS.map(agent => telemetry.span(`agent ${agent}`, { 'aerotrace.agent': agent, 'aerotrace.module': opts.module, 'aerotrace.fault': opts.faults?.[agent] ?? 'none' }, async setSpan => {
    const h = health.get(agent)!; const fault = opts.faults?.[agent] ?? 'none';
    let consecutive = 0;
    for (let attempt = 1; attempt <= retries; attempt++) {
      h.attempts++; if (attempt > 1) h.retries++;
      let acked = false; let ackResolve!: () => void;
      const ackP = new Promise<void>(r => { ackResolve = r; });
      const work = runAgent({ agent, c, idx, module: opts.module, broker, key: keys[agent], corr, llm, attempt, fault, shared,
        ack: () => { acked = true; online.add(agent); ackResolve(); } });
      try {
        await withTimeout(Promise.race([ackP, work.then(() => {})]), ackTimeout, `${agent} ack`);
        const found = await withTimeout(work, workTimeout, `${agent} work`);
        shared.findings.set(agent, found); consecutive = 0; h.breaker = 'closed';
        h.state = attempt > 1 ? 'degraded' : 'healthy';
        break;
      } catch (e) {
        if (!acked) online.delete(agent);
        consecutive++; h.failures++;
        const why = e instanceof Error ? e.message : String(e);
        if (consecutive >= retries) {
          h.breaker = 'open'; h.state = 'offline'; online.delete(agent);
          await orch('error', { text: `${agent}: ${why}. Retry ${attempt}/${retries} failed, circuit breaker open, agent marked offline. Its checks are queued for the next run.`, agent }, 'Orchestrator');
        } else {
          h.breaker = 'half-open';
          await orch('status', { text: `${agent}: ${why}. Retrying (${attempt}/${retries}) after ${150 * 2 ** (attempt - 1)} ms backoff.`, agent }, 'Orchestrator');
          await sleep(150 * 2 ** (attempt - 1));
        }
        pushHealth();
      }
    }
    setSpan({ 'aerotrace.agent.attempts': h.attempts, 'aerotrace.agent.retries': h.retries, 'aerotrace.agent.state': h.state, 'aerotrace.agent.breaker': h.breaker });
    pushHealth();
  })));

  phase('Exchanging dependencies between agents');
  if (online.has('Testing')) {
    await broker.publish('Testing', keys.Testing, { to: 'Requirements', type: 'dependency', correlationId: corr, payload: { needs: 'complete LLR set for every HLR', on: 'Requirements' } });
    await broker.publish('Testing', keys.Testing, { to: 'ConfigMgmt', type: 'dependency', correlationId: corr, payload: { needs: 'confirmation that tested files match the baseline', on: 'ConfigMgmt' } });
  }
  if (online.has('Design')) await broker.publish('Design', keys.Design, { to: 'Code', type: 'dependency', correlationId: corr, payload: { needs: 'call graph with cross-module calls', on: 'Code' } });
  for (const [a, to] of [['Requirements', 'Testing'], ['ConfigMgmt', 'Testing'], ['Code', 'Design']] as [AgentName, AgentName][])
    if (!online.has(a) && online.has(to)) await orch('status', { text: `${to} is waiting on ${a}, which is offline. Dependency unanswered.` }, 'Orchestrator');

  phase('Cross-checking Layer 2 against the source');
  const all: Finding[] = [...shared.findings.values()].flat();
  for (const f of all.filter(x => x.layer === 'L2')) {
    const r = crossCheck(f, c, idx); if (!r.ok) { f.status = 'rejected'; f.dispute = r.reason; }
  }
  for (const d of shared.disputes) {
    const f = all.find(x => x.id === d.findingId); if (f) { f.status = 'disputed'; f.dispute = d.reason; f.citations.push({ kind: 'code', id: f.ref, path: f.citations[0]?.path ?? '', quote: d.quote }); }
  }
  const rejectedL2 = all.filter(f => f.status === 'rejected').length;
  await orch('status', { text: `Cross-check: ${all.filter(f => f.layer === 'L2').length - rejectedL2} Layer 2 findings confirmed against source, ${rejectedL2} rejected, ${shared.disputes.length} Layer 1 findings disputed` }, 'Orchestrator');

  // Verdict: fixed rules, never model judgment.
  const confirmed = all.filter(f => f.status === 'confirmed');
  const offline = AGENTS.filter(a => health.get(a)!.state === 'offline');
  const { verdict, reason } = computeVerdict(confirmed, offline);

  const criticalPath = buildCriticalPath(confirmed, blockers, verdict);
  const nextActions = buildActions(confirmed, criticalPath, offline);
  await orch('result', { count: confirmed.length, verdict, critical: criticalPath.length });

  for (const [a, lat] of broker.latencies) { const h = health.get(a as AgentName); if (h) { h.p95Ms = p95(lat); h.messages = lat.length; } }
  health.get('Orchestrator')!.lastHeartbeat = Date.now();
  pushHealth();

  const truth = c.truth.filter(t => t.module === opts.module && t.kind !== 'ISR_FALSE_DEAD');
  const caught = truth.filter(t => confirmed.some(f => f.kind === t.kind && f.ref === t.ref)).length;
  const bySeverity = { '1': confirmed.filter(f => f.severity === 1).length, '2': confirmed.filter(f => f.severity === 2).length, '3': confirmed.filter(f => f.severity === 3).length };
  const chainValid = await verifyChain(broker.messages);
  const sevOrder = (f: Finding) => (f.status === 'confirmed' ? 0 : 10) + f.severity;
  all.sort((a, b) => sevOrder(a) - sevOrder(b) || a.agent.localeCompare(b.agent));

  const reportHash = await sha256(canonical(reportBodyFor({ id: runId, module: opts.module, baseline: c.baseline, verdict, verdictReason: reason, findings: all, criticalPath, messages: broker.messages })));
  return {
    id: runId, createdAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    program: c.program, baseline: c.baseline, module: mod.id, moduleName: mod.name, dal: mod.dal,
    options: opts, layer2Mode: llm ? 'llm' : 'heuristic', verdict, verdictReason: reason, complete: offline.length === 0,
    findings: all, criticalPath, nextActions, health: [...health.values()], messages: broker.messages, chainValid,
    stats: { recordsScanned: c.total, l1: all.filter(f => f.layer === 'L1').length, l2: all.filter(f => f.layer === 'L2').length,
      disputed: all.filter(f => f.status === 'disputed').length, rejected: rejectedL2, bySeverity,
      recall: truth.length ? caught / truth.length : 1, planted: truth.length, caught, llmCalls: shared.llmCalls,
      messages: broker.messages.length, rejectedMessages: broker.messages.filter(m => !m.accepted).length },
    reportHash, status: 'awaiting_approval',
  };
}

/** A buggy or compromised agent: a finding with no citations, then a message signed with its key but claiming to be another agent. */
async function forge(ctx: { broker: { publish: (...a: never[]) => Promise<unknown> }; key: unknown; corr: string }, agent: AgentName, sample?: Finding) {
  const pub = (ctx.broker.publish as unknown as (from: string, key: unknown, m: Record<string, unknown>) => Promise<unknown>).bind(ctx.broker);
  await pub(agent, ctx.key, { to: 'Orchestrator', type: 'finding', correlationId: ctx.corr, payload: { title: sample?.title ?? 'All objectives met', severity: sample?.severity ?? 3, citations: [] } });
  await pub(agent === 'Testing' ? 'ConfigMgmt' : 'Testing', ctx.key, { to: 'Orchestrator', type: 'status', correlationId: ctx.corr, payload: { text: 'all checks pass' } });
}

/** The verdict rule, in one place: used by every audit and by "what if we fix these?" projections. */
export function computeVerdict(confirmed: Pick<Finding, 'severity'>[], offline: string[]): { verdict: Verdict; reason: string } {
  const s1 = confirmed.filter(f => f.severity === 1).length;
  let verdict: Verdict = s1 ? 'NO' : confirmed.length ? 'CONDITIONAL' : 'YES';
  let reason = s1 ? `${s1} open severity-1 finding${s1 > 1 ? 's' : ''}. Not ready.`
    : confirmed.length ? `${confirmed.length} minor finding${confirmed.length > 1 ? 's' : ''}, each with an owner. No severity-1 items.`
    : 'All objectives met. No open findings.';
  if (offline.length) {
    if (verdict === 'YES') verdict = 'CONDITIONAL';
    reason += ` Incomplete: ${offline.join(', ')} offline, so ${offline.length > 1 ? 'their' : 'its'} objectives were not checked.`;
  }
  return { verdict, reason };
}
export const ACTION_FOR_KIND = (k: string): [string, string] | undefined => ACTION[k];

function buildCriticalPath(confirmed: Finding[], blockers: { from: AgentName; to: AgentName; findings: string[]; impact: string }[], verdict: Verdict): CriticalStep[] {
  const byId = new Map(confirmed.map(f => [f.id, f]));
  let best: CriticalStep[] = []; let bestScore = -1;
  for (const b of blockers) {
    const fs = b.findings.map(id => byId.get(id)).filter(Boolean) as Finding[];
    if (!fs.length) continue;
    const top = fs.sort((x, y) => x.severity - y.severity)[0];
    const score = (4 - top.severity) * 10 + fs.length;
    if (score > bestScore) {
      bestScore = score;
      best = [{ agent: b.from, finding: top.id, title: top.title + (fs.length > 1 ? ` (+${fs.length - 1} more)` : '') }, { agent: b.to, finding: '', title: b.impact }];
    }
  }
  if (!best.length) {
    const top = [...confirmed].sort((x, y) => x.severity - y.severity)[0];
    if (top) best = [{ agent: top.agent, finding: top.id, title: top.title }];
  }
  if (best.length) best.push({ agent: 'Orchestrator', finding: '', title: `Verdict held at ${verdict}` });
  return best;
}

const ACTION: Record<string, [string, string]> = {
  HLR_NO_LLR: ['Write low-level requirements for the HLRs that have none', 'Requirements lead'],
  LLR_ORPHAN: ['Re-parent orphan LLRs to an existing HLR', 'Requirements lead'],
  REQ_AMBIGUOUS: ['Rewrite vague requirements with "shall" and a measurable value', 'Requirements lead'],
  COUPLING_UNDOC: ['Add the undocumented module couplings to the architecture', 'Design lead'],
  FN_NO_LLR: ['Trace untraced functions to an LLR, or remove them', 'Code owner'],
  FN_BAD_TAG: ['Fix trace tags that point at unknown requirement IDs', 'Code owner'],
  DEAD_CODE: ['Remove dead functions or record a justification', 'Code owner'],
  CODE_REQ_MISMATCH: ['Resolve code thresholds that contradict their requirement', 'Code owner + Requirements lead'],
  LLR_NO_TEST: ['Write test cases for untested LLRs', 'Test lead'],
  TEST_NO_RESULT: ['Run the tests with no recorded result on this baseline', 'Test lead'],
  TEST_FAIL: ['Fix and re-run failing tests', 'Test lead'],
  COVERAGE_GAP: ['Add test vectors to close structural coverage gaps', 'Test lead'],
  CHECKSUM_MISMATCH: ['Re-baseline the changed files and re-run their tests', 'CM lead'],
  OPEN_PR: ['Close or defer open problem reports against the baseline', 'Software lead'],
};
function buildActions(confirmed: Finding[], path: CriticalStep[], offline: AgentName[]): NextAction[] {
  const crit = new Set(path.map(p => confirmed.find(f => f.id === p.finding)?.kind).filter(Boolean));
  const groups = new Map<string, Finding[]>();
  confirmed.forEach(f => { const g = groups.get(f.kind) ?? []; g.push(f); groups.set(f.kind, g); });
  const out: NextAction[] = [...groups.entries()].map(([k, fs]) => ({
    action: ACTION[k]?.[0] ?? k, owner: ACTION[k]?.[1] ?? fs[0].owner, count: fs.length,
    onCriticalPath: crit.has(k as Finding['kind']), severity: Math.min(...fs.map(f => f.severity)) as Severity,
  }));
  offline.forEach(a => out.push({ action: `Restore the ${a} agent and re-run its checks`, owner: 'Platform on-call', count: 1, onCriticalPath: true, severity: 1 }));
  return out.sort((a, b) => Number(b.onCriticalPath) - Number(a.onCriticalPath) || a.severity - b.severity || b.count - a.count);
}

/** The exact content the report hash (and therefore every signature) covers. */
export function reportBodyFor(r: Pick<AuditRun, 'id' | 'module' | 'baseline' | 'verdict' | 'verdictReason' | 'findings' | 'criticalPath' | 'messages'>) {
  return { runId: r.id, module: r.module, baseline: r.baseline, verdict: r.verdict, reason: r.verdictReason,
    findings: r.findings.map(f => [f.id, f.status, f.severity, f.title]), criticalPath: r.criticalPath, chainTail: r.messages.at(-1)?.hash ?? 'GENESIS' };
}
export async function reportHashFor(r: AuditRun): Promise<string> { return sha256(canonical(reportBodyFor(r))); }
