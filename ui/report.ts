import type { AuditRun } from '../lib/engine/types';
import { AGENT_LABEL } from '../lib/engine/types';
export function toMarkdown(r: AuditRun): string {
  const L: string[] = [];
  L.push(`# AeroTrace audit report: ${r.module} (${r.moduleName})`, '');
  L.push(`- Verdict: **${r.verdict}**. ${r.verdictReason}`, `- DAL ${r.dal} · baseline ${r.baseline} · run ${r.id}`, `- Started ${r.createdAt} by ${r.options.requestedBy ?? 'unknown'} · ${r.durationMs} ms · Layer 2: ${r.layer2Mode}`,
    `- Report hash: \`${r.reportHash}\` · message trail ${r.chainValid ? 'verified' : 'FAILED verification'} (${r.stats.messages} messages, ${r.stats.rejectedMessages} rejected)`);
  if (r.decision) L.push(`- Decision: **${r.decision.action === 'approve' ? 'APPROVED' : 'DENIED'}** by ${r.decision.by} at ${r.decision.at}${r.decision.reason ? ` (${r.decision.reason})` : ''} · signature \`${r.decision.signature.slice(0, 24)}…\``);
  else L.push('- Decision: awaiting reviewer');
  L.push('', '## Critical path', ...r.criticalPath.map((s, i) => `${i + 1}. ${AGENT_LABEL[s.agent]}: ${s.title}`), '', '## Next actions');
  r.nextActions.forEach(a => L.push(`- ${a.onCriticalPath ? '**[critical path]** ' : ''}${a.action} (${a.count}) · ${a.owner}`));
  L.push('', '## Findings', '', '| ID | Layer | Status | Sev | Agent | Objective | Finding | Evidence |', '|---|---|---|---|---|---|---|---|');
  r.findings.forEach(f => L.push(`| ${f.id} | ${f.layer} | ${f.status} | ${f.severity} | ${AGENT_LABEL[f.agent]} | Table ${f.objective} | ${f.title.replace(/\|/g, '/')}${f.dispute ? ` (${f.dispute.replace(/\|/g, '/')})` : ''} | ${f.citations.map(c => c.path).join('<br>')} |`));
  L.push('', '## Agent health', '', '| Agent | State | Attempts | Retries | Breaker | p95 ms | Messages |', '|---|---|---|---|---|---|---|');
  r.health.forEach(h => L.push(`| ${AGENT_LABEL[h.agent]} | ${h.state} | ${h.attempts} | ${h.retries} | ${h.breaker} | ${h.p95Ms} | ${h.messages} |`));
  return L.join('\n') + '\n';
}
