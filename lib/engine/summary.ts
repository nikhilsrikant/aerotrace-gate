import type { AuditRun, RunSummary } from './types';
export function summarize(r: AuditRun): RunSummary {
  const conf = r.findings.filter(f => f.status === 'confirmed');
  return {
    id: r.id, createdAt: r.createdAt, module: r.module, moduleName: r.moduleName, dal: r.dal, verdict: r.verdict,
    verdictReason: r.verdictReason, status: r.status, complete: r.complete, layer2Mode: r.layer2Mode, reportHash: r.reportHash,
    durationMs: r.durationMs, decision: r.decision, requestedBy: r.options.requestedBy,
    counts: { l1: r.stats.l1, l2: r.stats.l2, disputed: r.stats.disputed, s1: r.stats.bySeverity['1'], s2: r.stats.bySeverity['2'], s3: r.stats.bySeverity['3'] },
    top: conf.filter((f, i, a) => a.findIndex(x => x.kind === f.kind) === i).slice(0, 3).map(f => ({ severity: f.severity, title: f.title, agent: f.agent })),
  };
}
