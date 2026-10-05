// Program-wide readiness: one picture across every module, built from the latest audit of each.
// Pure functions over run records, so the server, the browser demo and the tests compute the same thing.
import { computeVerdict, ACTION_FOR_KIND } from '../engine';
import type { AgentName, AuditRun, DAL, Finding, Verdict } from '../engine/types';
import { AGENTS } from '../engine/types';
import type { RunRecord, RunStatus } from './model';

export interface ModuleCell { id: string; name: string; dal: DAL; status: RunStatus | 'not_audited'; verdict: Verdict | null; runId: string | null; at: string | null; s1: number; findings: number; trigger?: RunRecord['trigger'] }
export interface AgentRow {
  agent: AgentName; runs: number; healthy: number; degraded: number; offline: number; retries: number; failures: number; breakerTrips: number;
  p95Median: number; p95Last: number; series: { runId: string; module: string; at: string; p95: number; retries: number; state: string }[];
}
export interface Blocker { module: string; dal: DAL; verdict: Verdict; runId: string; action: string; owner: string; count: number; severity: number; onCriticalPath: boolean }
export interface OwnerImpact { owner: string; items: number; s1: number; modules: number; toYes: number; toConditional: number; stillNo: number }
export interface ProgramOverview {
  generatedAt: string;
  dataset: { id: string; name: string; program: string; baseline: string; total: number } | null;
  program: { verdict: Verdict; reason: string };
  counts: { modules: number; YES: number; CONDITIONAL: number; NO: number; running: number; failed: number; notAudited: number; approved: number; awaiting: number; denied: number };
  modules: ModuleCell[];
  agents: AgentRow[];
  flow: { actors: string[]; cells: { from: string; to: string; count: number; rejected: number; byType: Record<string, number> }[]; total: number; rejected: number };
  daily: { day: string; runs: number; YES: number; CONDITIONAL: number; NO: number; failed: number; retries: number }[];
  blockers: Blocker[];
  owners: OwnerImpact[];
  /** Smallest groups of owners that move the most modules, by team size. */
  plan: { owners: string[]; NO: number; CONDITIONAL: number; YES: number }[];
  faults: { runId: string; module: string; at: string; agent: string; state: string; retries: number; breaker: string; faults: Record<string, string> }[];
}

const DAL_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const ownerOf = (f: Pick<Finding, 'kind' | 'owner'>) => ACTION_FOR_KIND(f.kind)?.[1] ?? f.owner;

/**
 * modules: the dataset's module list. runs: visible run records, newest first. results: finished results by run id
 * (at least the latest per module, plus recent ones for trends). days: how far back the daily series goes.
 */
export function buildProgramOverview(i: {
  dataset: ProgramOverview['dataset']; modules: { id: string; name: string; dal: DAL }[]; runs: RunRecord[];
  results: Map<string, AuditRun>; now: Date; days?: number;
}): ProgramOverview {
  const { modules, runs, results, now } = i;
  const latest = new Map<string, RunRecord>();
  for (const r of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) if (!latest.has(r.module)) latest.set(r.module, r);

  const cells: ModuleCell[] = modules.map(m => {
    const r = latest.get(m.id);
    if (!r) return { id: m.id, name: m.name, dal: m.dal, status: 'not_audited', verdict: null, runId: null, at: null, s1: 0, findings: 0 };
    const res = results.get(r.id);
    const conf = res ? res.findings.filter(f => f.status === 'confirmed') : [];
    return { id: m.id, name: m.name, dal: m.dal, status: r.status, verdict: r.verdict ?? null, runId: r.id, at: r.createdAt, trigger: r.trigger,
      s1: res ? conf.filter(f => f.severity === 1).length : (r.summary?.counts.s1 ?? 0), findings: res ? conf.length : 0 };
  });
  const done = cells.filter(c => c.verdict);
  const counts = {
    modules: cells.length,
    YES: done.filter(c => c.verdict === 'YES').length, CONDITIONAL: done.filter(c => c.verdict === 'CONDITIONAL').length, NO: done.filter(c => c.verdict === 'NO').length,
    running: cells.filter(c => c.status === 'queued' || c.status === 'running').length, failed: cells.filter(c => c.status === 'failed').length,
    notAudited: cells.filter(c => c.status === 'not_audited').length,
    approved: cells.filter(c => c.status === 'approved').length, awaiting: cells.filter(c => c.status === 'awaiting_approval').length, denied: cells.filter(c => c.status === 'denied').length,
  };
  const unknown = counts.notAudited + counts.running + counts.failed;
  const program: ProgramOverview['program'] = counts.NO
    ? { verdict: 'NO', reason: `${counts.NO} of ${counts.modules} modules are NO. ${cells.filter(c => c.verdict === 'NO' && (c.dal === 'A' || c.dal === 'B')).length} of them are DAL A or B.` }
    : counts.CONDITIONAL || unknown
      ? { verdict: 'CONDITIONAL', reason: `No module is NO. ${counts.CONDITIONAL} conditional${unknown ? `, ${unknown} without a finished audit` : ''}.` }
      : { verdict: 'YES', reason: `All ${counts.modules} modules are YES.` };

  // Agent health across the latest audit of each module.
  const latestRes = [...latest.values()].map(r => results.get(r.id)).filter((x): x is AuditRun => !!x);
  const recent = [...results.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-60);
  const agents: AgentRow[] = AGENTS.map(agent => {
    const hs = latestRes.map(r => r.health.find(h => h.agent === agent)).filter(Boolean) as AuditRun['health'];
    const series: AgentRow['series'] = [];
    for (const r of recent) { const h = r.health.find(x => x.agent === agent); if (h) series.push({ runId: r.id, module: r.module, at: r.createdAt, p95: h.p95Ms, retries: h.retries, state: h.state }); }
    return { agent, runs: hs.length, healthy: hs.filter(h => h.state === 'healthy').length, degraded: hs.filter(h => h.state === 'degraded').length, offline: hs.filter(h => h.state === 'offline').length,
      retries: hs.reduce((n, h) => n + h.retries, 0), failures: hs.reduce((n, h) => n + h.failures, 0), breakerTrips: hs.filter(h => h.breaker !== 'closed').length,
      p95Median: median(hs.map(h => h.p95Ms)), p95Last: series.at(-1)?.p95 ?? 0, series };
  });

  // Who talks to whom, from the latest audits' message trails.
  const actors = ['Orchestrator', ...AGENTS];
  const flowMap = new Map<string, { from: string; to: string; count: number; rejected: number; byType: Record<string, number> }>();
  let total = 0, rejected = 0;
  for (const r of latestRes) for (const m of r.messages) {
    const to = m.to === '*' ? 'Orchestrator' : m.to; const k = `${m.from}>${to}`;
    const c = flowMap.get(k) ?? { from: m.from, to, count: 0, rejected: 0, byType: {} };
    c.count++; total++; c.byType[m.type] = (c.byType[m.type] ?? 0) + 1; if (!m.accepted) { c.rejected++; rejected++; }
    flowMap.set(k, c);
  }

  // Daily trend.
  const days = i.days ?? 14; const daily: ProgramOverview['daily'] = [];
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86400e3).toISOString().slice(0, 10);
    const rs = runs.filter(r => r.createdAt.slice(0, 10) === day);
    daily.push({ day, runs: rs.length, YES: rs.filter(r => r.verdict === 'YES').length, CONDITIONAL: rs.filter(r => r.verdict === 'CONDITIONAL').length, NO: rs.filter(r => r.verdict === 'NO').length,
      failed: rs.filter(r => r.status === 'failed').length, retries: rs.reduce((n, r) => n + (results.get(r.id)?.health.reduce((k, h) => k + h.retries, 0) ?? 0), 0) });
  }

  // Program blockers: every next action from modules that aren't YES, ranked.
  const blockers: Blocker[] = [];
  for (const c of cells) {
    if (!c.runId || !c.verdict || c.verdict === 'YES') continue;
    const r = results.get(c.runId); if (!r) continue;
    for (const a of r.nextActions) blockers.push({ module: c.id, dal: c.dal, verdict: c.verdict, runId: c.runId, action: a.action, owner: a.owner, count: a.count, severity: a.severity, onCriticalPath: a.onCriticalPath });
  }
  blockers.sort((a, b) => Number(b.onCriticalPath) - Number(a.onCriticalPath) || a.severity - b.severity || DAL_RANK[a.dal] - DAL_RANK[b.dal] || b.count - a.count || a.module.localeCompare(b.module));

  // What if each owner cleared their items? Re-run the verdict rule without them.
  const ownerNames = [...new Set(blockers.map(b => b.owner))];
  const owners: OwnerImpact[] = ownerNames.map(owner => {
    let toYes = 0, toConditional = 0, stillNo = 0, s1 = 0, items = 0; const mods = new Set<string>();
    for (const c of cells) {
      if (!c.runId || !c.verdict || c.verdict === 'YES') continue;
      const r = results.get(c.runId); if (!r) continue;
      const conf = r.findings.filter(f => f.status === 'confirmed');
      const mine = conf.filter(f => ownerOf(f) === owner);
      const offline = r.health.filter(h => h.state === 'offline' && h.agent !== 'Orchestrator').map(h => h.agent);
      const clearsOffline = owner === 'Platform on-call' && offline.length > 0;
      if (!mine.length && !clearsOffline) continue;
      mods.add(c.id); items += mine.length + (clearsOffline ? offline.length : 0); s1 += mine.filter(f => f.severity === 1).length;
      const after = computeVerdict(conf.filter(f => ownerOf(f) !== owner), clearsOffline ? [] : offline).verdict;
      if (after === c.verdict) { if (after === 'NO') stillNo++; continue; }
      if (after === 'YES') toYes++; else if (after === 'CONDITIONAL') toConditional++;
    }
    return { owner, items, s1, modules: mods.size, toYes, toConditional, stillNo };
  }).sort((a, b) => (b.toYes + b.toConditional) - (a.toYes + a.toConditional) || b.s1 - a.s1 || b.items - a.items);

  // Cumulative plan: pick the owner that, together with those already picked, improves the most modules.
  const open = cells.filter(c => c.runId && c.verdict && c.verdict !== 'YES').map(c => results.get(c.runId!)).filter((x): x is AuditRun => !!x);
  const verdictsWith = (cleared: Set<string>) => open.map(r => {
    const conf = r.findings.filter(f => f.status === 'confirmed' && !cleared.has(ownerOf(f)));
    const offline = cleared.has('Platform on-call') ? [] : r.health.filter(h => h.state === 'offline' && h.agent !== 'Orchestrator').map(h => h.agent);
    return computeVerdict(conf, offline).verdict;
  });
  const score = (vs: Verdict[]) => ({ NO: vs.filter(v => v === 'NO').length, CONDITIONAL: vs.filter(v => v === 'CONDITIONAL').length, YES: vs.filter(v => v === 'YES').length });
  // Best combination of owners for each team size (owners are few, so try every combination), stopping once nothing improves.
  const plan: ProgramOverview['plan'] = [];
  const names = ownerNames.slice(0, 10); const s1Of = (o: string) => owners.find(x => x.owner === o)?.s1 ?? 0;
  const keyOf = (sc: ReturnType<typeof score>) => -sc.NO * 1e6 + sc.YES * 1000 + sc.CONDITIONAL;   // fewest NO first, then most YES
  let prevKey = keyOf(score(open.map(r => (r.verdict as Verdict))));
  for (let k = 1; k <= names.length; k++) {
    let best: { set: string[]; sc: ReturnType<typeof score>; key: number; s1: number } | null = null;
    const combo = (start: number, pick: string[]) => {
      if (pick.length === k) { const sc = score(verdictsWith(new Set(pick))); const key = keyOf(sc); const s1 = pick.reduce((n, o) => n + s1Of(o), 0);
        if (!best || key > best.key || (key === best.key && s1 > best.s1)) best = { set: [...pick], sc, key, s1 }; return; }
      for (let j = start; j < names.length; j++) { pick.push(names[j]); combo(j + 1, pick); pick.pop(); }
    };
    combo(0, []);
    const b = best as { set: string[]; sc: ReturnType<typeof score>; key: number } | null;
    if (!b || b.key <= prevKey) continue;
    plan.push({ owners: b.set, ...b.sc }); prevKey = b.key;
    if (b.sc.NO === 0 && b.sc.CONDITIONAL === 0) break;
    if (plan.length >= 3) break;
  }

  const faults = runs.slice(0, 200).flatMap(r => {
    const res = results.get(r.id); const f = r.options?.faults ?? {};
    if (!res) return [];
    return res.health.filter(h => h.agent !== 'Orchestrator' && (h.state !== 'healthy' || h.retries > 0 || h.breaker !== 'closed'))
      .map(h => ({ runId: r.id, module: r.module, at: r.createdAt, agent: h.agent, state: h.state, retries: h.retries, breaker: h.breaker, faults: f as Record<string, string> }));
  }).slice(0, 12);

  return { generatedAt: now.toISOString(), dataset: i.dataset, program, counts, modules: cells, agents,
    flow: { actors, cells: [...flowMap.values()], total, rejected }, daily, blockers, owners, plan, faults };
}

/** "What if these findings were fixed?" on one audit, with the same verdict rule. */
export function projectVerdict(r: Pick<AuditRun, 'findings' | 'health'>, fixedKinds: string[], restoreOffline = false) {
  const conf = r.findings.filter(f => f.status === 'confirmed');
  const remaining = conf.filter(f => !fixedKinds.includes(f.kind));
  const offline = restoreOffline ? [] : r.health.filter(h => h.state === 'offline' && h.agent !== 'Orchestrator').map(h => h.agent);
  return { ...computeVerdict(remaining, offline), remaining: remaining.length, s1: remaining.filter(f => f.severity === 1).length };
}
