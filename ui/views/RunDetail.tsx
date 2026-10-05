'use client';
import { useEffect, useMemo, useState } from 'react';
import { useApp, useLoad, useAction, Verdict, Status, Loading, ErrorBox, when, fmt } from '../kit';
import { Steps, Trigger, HealthGrid, Trail, FindingsTable } from './parts';
import { AGENT_LABEL } from '../../lib/engine/types';
import { toMarkdown } from '../report';
import type { Check, Diff, ScheduleInput } from '../api';
import { ScheduleEditor, localTz } from './Schedules';
import { projectVerdict } from '../../lib/core/program';
import { checkDrill } from '../../lib/core/chaos';
import { ACTION_FOR_KIND } from '../../lib/engine';
import type { AuditRun } from '../../lib/engine/types';

const REASONS = ['Evidence incomplete', 'Disputed findings unresolved', 'Re-run on new baseline'];

export function RunDetail({ id }: { id: string }) {
  const { api, bump, go, can, focus, setFocus, me } = useApp();
  const [poll, setPoll] = useState(true);
  const { data: run, error, reload } = useLoad(async () => { const r = await api.run(id); setPoll(['queued', 'running'].includes(r.status)); return r; }, [id], poll ? 1000 : undefined);
  const [tab, setTab] = useState<'findings' | 'changes' | 'path' | 'agents' | 'verify' | 'report'>('findings');
  const [layer, setLayer] = useState<'all' | 'L1' | 'L2' | 'disputed' | 'rejected'>('all');
  const [reason, setReason] = useState('');
  const [checks, setChecks] = useState<{ ok: boolean; checks: Check[] } | null>(null);
  const [diff, setDiff] = useState<Diff | null | 'loading'>(null);
  const [pkg, setPkg] = useState<string | null>(null);
  const { busy, run: act } = useAction();
  const [auto, setAuto] = useState<ScheduleInput | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const res = run?.result;
  // A citation from the assistant points at a finding: show it, scroll to it, then let it go.
  useEffect(() => {
    if (!focus || !res) return;
    const f = res.findings.find(x => x.id === focus); if (!f) return;
    setTab('findings'); setLayer(f.status === 'rejected' ? 'rejected' : 'all'); setLit(focus); setFocus(null);
    setTimeout(() => document.getElementById('f-' + focus)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
  }, [focus, res, setFocus]);
  const shown = useMemo(() => !res ? [] : res.findings.filter(f => layer === 'all' ? f.status !== 'rejected' : layer === 'disputed' ? f.status === 'disputed' : layer === 'rejected' ? f.status === 'rejected' : f.layer === layer && f.status !== 'rejected'), [res, layer]);
  if (error) return <ErrorBox error={error} />;
  if (!run) return <Loading what="Loading the audit" />;

  const decide = async (a: 'approve' | 'deny') => { const r = await act(a, () => api.decide(run.id, a, a === 'deny' ? reason : undefined), a === 'approve' ? 'Approved. Signed with your passkey and logged.' : 'Denied. Signed with your passkey and logged.'); if (r) { await reload(); bump(); } };
  const head = <div className="pagehead"><div><div className="eyebrow">{run.datasetName} · baseline {run.baseline} · {run.id}</div>
    <h1>{run.module} · {run.moduleName}</h1>
    <p>DAL {run.dal} · requested by {run.requestedByName} · {when(run.createdAt)}{res ? ` · ${fmt(res.durationMs)} ms · Layer 2 ${res.layer2Mode === 'llm' ? 'LLM' : 'rule-based'}` : ''} <Trigger r={run} /></p></div>
    <div className="row"><Status s={run.status} />{can('schedule.manage') && <button className="btn sm" title="Run this module on this dataset by itself on a schedule" onClick={() => setAuto({ name: `${run.module} · every 24 hours`, datasetId: run.datasetId, modules: [run.module], layer2: 'auto', recurrence: { kind: 'interval', everyMinutes: 1440 }, timezone: localTz(), enabled: true, skipIfPending: true, notifyOn: ['NO', 'failed'] })}>Automate this audit</button>}<button className="btn sm" onClick={() => go('runs')}>All audits</button></div>
    {auto && <ScheduleEditor value={auto} datasets={[{ id: run.datasetId, name: run.datasetName }]} onClose={() => setAuto(null)} onSaved={() => { setAuto(null); bump(); go('schedules'); }} />}</div>;

  if (!res) return <>{head}
    <div className="panel">
      <div className="row"><h2 className="grow">{run.status === 'failed' ? 'This audit failed' : run.status === 'queued' ? 'Waiting for a worker' : run.progress?.phase ?? 'Running'}</h2>{run.status !== 'failed' && <span className="spin" />}</div>
      {run.error && <p className="err-text">{run.error}{run.status === 'queued' ? ' It will be retried automatically.' : ''}</p>}
      {run.progress?.health?.length ? <HealthGrid health={run.progress.health.filter(h => h.agent !== 'Orchestrator')} /> : null}
      {run.progress?.messages?.length ? <Trail messages={run.progress.messages} follow /> : <span className="dim">Agent messages appear here as the audit runs.</span>}
    </div></>;

  const a = run.approval;
  const drillFaults = Object.fromEntries(Object.entries(run.options?.faults ?? {}).filter(([, f]) => f && f !== 'none'));
  const drill = Object.keys(drillFaults).length ? checkDrill(drillFaults, res) : null;
  return <>{head}
    {drill && <div className="panel drillcard">
      <div className="row"><h2 className="grow">Chaos drill result</h2><span className={`pill ${drill.every(c => c.ok) ? 'ok' : 'bad'}`}>{drill.every(c => c.ok) ? 'Behaved as designed' : 'Unexpected behaviour'}</span></div>
      <p className="sm dim2" style={{ margin: 0 }}>Faults injected on purpose: {Object.entries(drillFaults).map(([ag, f]) => `${ag} ${f}`).join(', ')}. Each line is read from the finished audit.</p>
      <ul className="actions">{drill.map((c, i) => <li key={i}><span className={`pill ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'Pass' : 'Fail'}</span><b>{c.label}</b><span className="grow dim2">{c.detail}</span></li>)}</ul>
    </div>}
    <div className="decide">
      <Verdict v={res.verdict} lg />
      <div className="grow" style={{ minWidth: 220 }}><b>{res.verdictReason}</b><div className="dim mono" style={{ fontSize: 11.5 }}>report {run.reportHash?.slice(0, 20)}… · trail {res.chainValid ? 'verified' : 'FAILED'} · {a.policyName ?? 'no policy'}{a.policyVersion ? ` v${a.policyVersion}` : ''}</div></div>
      {a.canAct ? <div className="dact">
        <div className="sm dim2">You sign <b>{a.myStep}</b>{a.onBehalfOf ? <> on behalf of <b>{a.onBehalfOf}</b></> : null}{me.assurance?.signDecisions ? ' · your passkey signs it' : ''}</div>
        <div className="row" style={{ gap: 8 }}><button className="btn approve" disabled={!!busy} onClick={() => decide('approve')}>{busy === 'approve' ? 'Touch your passkey…' : 'Approve'}</button><button className="btn deny" disabled={!!busy} onClick={() => decide('deny')}>{busy === 'deny' ? 'Touch your passkey…' : 'Deny'}</button></div>
        <div className="reasons">{REASONS.map(x => <button key={x} aria-pressed={reason === x} onClick={() => setReason(r => r === x ? '' : x)}>{x}</button>)}</div>
        <input aria-label="Reason (optional unless the policy asks for one)" placeholder={a.denyRequiresReason ? 'Reason (needed to deny)' : 'Reason (optional)'} value={reason} onChange={e => setReason(e.target.value)} className="reason-input" />
      </div> : <div className="sm dim2" style={{ maxWidth: 360 }}>{run.status === 'awaiting_approval' ? (a.actReason ?? a.waitingOn) : a.waitingOn}</div>}
    </div>
    <div className="grid2">
      <div className="panel"><div className="row"><h2 className="grow">Approval</h2><span className="dim sm">{a.sequential ? 'Steps in order' : 'Steps in any order'}</span></div>
        <Steps a={a} />
        {run.decisions.map(d => <div key={d.id} className="sig sm"><span className={`pill ${d.action === 'approve' ? 'ok' : 'bad'}`}>{d.action === 'approve' ? 'Approved' : 'Denied'}</span> {d.stepName} · {d.userName}{d.onBehalfOf ? ` for ${d.onBehalfOf.name}` : ''} · {when(d.at)}{d.reason ? ` · "${d.reason}"` : ''}{d.passkey && <span className="pill acc" style={{ marginLeft: 6 }} title={`Passkey ${d.passkey.credentialId.slice(0, 12)}… · user verified: ${d.passkey.userVerified ? 'yes' : 'no'}`}>Passkey-signed</span>}<div className="mono dim">{d.signature.alg} {d.signature.keyId} · {d.signature.value.slice(0, 32)}…</div></div>)}
      </div>
      <div className="tiles">
        <div className="tile"><span className="eyebrow">Records scanned</span><span className="v">{fmt(res.stats.recordsScanned)}</span><span className="s">whole program</span></div>
        <div className="tile"><span className="eyebrow">Layer 1 · rules</span><span className="v">{res.stats.l1}</span><span className="s">{res.stats.disputed} disputed by Layer 2</span></div>
        <div className="tile"><span className="eyebrow">Layer 2 · semantic</span><span className="v">{res.stats.l2 - res.stats.rejected}</span><span className="s">{res.stats.rejected} rejected by cross-check</span></div>
        <div className="tile"><span className="eyebrow">Severity 1 / 2 / 3</span><span className="v">{res.stats.bySeverity['1']} / {res.stats.bySeverity['2']} / {res.stats.bySeverity['3']}</span><span className="s">confirmed</span></div>
        {res.stats.planted > 0 && <div className="tile"><span className="eyebrow">Recall vs planted</span><span className="v">{(res.stats.recall * 100).toFixed(0)}%</span><span className="s">{res.stats.caught} of {res.stats.planted}</span></div>}
        <div className="tile"><span className="eyebrow">A2A messages</span><span className="v">{res.stats.messages}</span><span className="s">{res.stats.rejectedMessages} rejected</span></div>
      </div>
    </div>
    <div className="tabs" role="tablist">
      {([['findings', 'Findings'], ['changes', 'Changes since last audit'], ['path', 'Critical path and actions'], ['agents', 'Agents and messages'], ['verify', 'Verify and export'], ['report', 'Report']] as const).map(([k, l]) =>
        <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); if (k === 'changes' && diff === null) { setDiff('loading'); api.diff(run.id).then(setDiff); } }}>{l}</button>)}
    </div>
    {tab === 'findings' && <>
      <div className="seg" role="group" aria-label="Filter findings">
        {([['all', 'Confirmed and disputed'], ['L1', 'Layer 1'], ['L2', 'Layer 2'], ['disputed', `Disputed (${res.stats.disputed})`], ['rejected', `Rejected (${res.stats.rejected})`]] as const).map(([k, l]) =>
          <button key={k} aria-pressed={layer === k} onClick={() => setLayer(k)}>{l}</button>)}
      </div>
      <FindingsTable findings={shown} focus={lit} />
    </>}
    {tab === 'changes' && (diff === 'loading' || diff === null ? <Loading what="Comparing with the previous audit" /> : !diff.previous ? <div className="empty">No earlier audit of {run.module} on this dataset to compare with.</div> :
      <div className="grid2">
        <div className="panel"><h2>New since {when(diff.previous.createdAt)} <span className="dim sm">({diff.previous.verdict}, {diff.previous.status.replace('_', ' ')})</span></h2>
          {diff.added.length ? <ul className="actions">{diff.added.map((f, i) => <li key={i}><span className={`pill s${f.severity}`}>S{f.severity}</span><span className="dim">{AGENT_LABEL[f.agent]}</span><span className="grow">{f.title}</span></li>)}</ul> : <span className="dim">Nothing new.</span>}</div>
        <div className="panel"><h2>Resolved</h2>
          {diff.resolved.length ? <ul className="actions">{diff.resolved.map((f, i) => <li key={i}><span className="pill ok">fixed</span><span className="dim">{AGENT_LABEL[f.agent]}</span><span className="grow">{f.title}</span></li>)}</ul> : <span className="dim">Nothing resolved.</span>}
          <span className="dim sm">{diff.unchanged} findings unchanged.</span></div>
      </div>)}
    {tab === 'path' && <div className="grid2">
      <div className="panel"><h2>Critical path</h2>
        {res.criticalPath.length ? <ol className="critical">{res.criticalPath.map((s, i) => <li key={i}><span className="dot">{i + 1}</span><div><div className="eyebrow">{AGENT_LABEL[s.agent]}</div><div>{s.title}</div>{s.finding && <span className="mono dim" style={{ fontSize: 11.5 }}>{s.finding}</span>}</div></li>)}</ol> : <span className="dim">No blockers.</span>}</div>
      <div className="panel"><h2>Next actions</h2><ul className="actions">{res.nextActions.map((x, i) => <li key={i}>
        {x.onCriticalPath && <span className="pill bad">Critical path</span>}<span className={`pill s${x.severity}`}>S{x.severity}</span><span className="grow">{x.action} <span className="dim">({x.count})</span></span><span className="dim">{x.owner}</span></li>)}</ul></div>
      <div className="panel" style={{ gridColumn: '1 / -1' }}><WhatIf res={res} /></div>
    </div>}
    {tab === 'agents' && <><HealthGrid health={res.health} /><Trail messages={res.messages} /></>}
    {tab === 'verify' && <div className="panel">
      <div className="row"><h2 className="grow">Independent verification</h2>
        <button className="btn" disabled={busy === 'v'} onClick={() => act('v', async () => setChecks(await api.verify(run.id)))}>Verify now</button>
        {api.evidenceUrl(run.id) && api.fetchFile ? <button className="btn primary" disabled={busy === 'ev'} onClick={() => act('ev', async () => save(await api.fetchFile!(api.evidenceUrl(run.id)!), `aerotrace-evidence-${run.id}.json`))}>Download evidence package</button>
          : <button className="btn primary" disabled={busy === 'ev'} onClick={() => act('ev', async () => setPkg(JSON.stringify(await api.evidence(run.id), null, 2)))}>Show evidence package</button>}</div>
      <p className="dim2" style={{ margin: 0 }}>Re-checks the agents' message hash chain, recomputes the report hash, and verifies every approval signature. The evidence package holds the report, decisions, the public key and this run's audit-log entries, so an auditor can check it without access to this system.</p>
      {pkg && <pre className="md">{pkg.slice(0, 20000)}{pkg.length > 20000 ? '\n…' : ''}</pre>}
      {checks && <ul className="actions">{checks.checks.map((c, i) => <li key={i}><span className={`pill ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'Pass' : 'Fail'}</span><b>{c.name}</b><span className="grow dim2">{c.detail}</span></li>)}</ul>}
    </div>}
    {tab === 'report' && <div className="panel">
      <div className="row"><h2 className="grow">Audit report</h2>{api.reportUrl(run.id) && api.fetchFile ? <button className="btn" disabled={busy === 'md'} onClick={() => act('md', async () => save(await api.fetchFile!(api.reportUrl(run.id)!), `aerotrace-${run.module}-${run.id}.md`))}>Download Markdown</button> :
        null}</div>
      <pre className="md">{toMarkdown(res)}</pre></div>}
  </>;
}

function save(blob: Blob, name: string) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 5000); }

/** "If we fixed these, what would the verdict be?" Same rule as the audit; nothing is changed or signed. */
function WhatIf({ res }: { res: AuditRun }) {
  const kinds = [...new Set(res.findings.filter(f => f.status === 'confirmed').map(f => f.kind))];
  const offline = res.health.filter(h => h.state === 'offline' && h.agent !== 'Orchestrator');
  const [fixed, setFixed] = useState<string[]>([]); const [restore, setRestore] = useState(false);
  const proj = projectVerdict(res, fixed, restore);
  if (!kinds.length && !offline.length) return <><h2>What if…</h2><span className="dim">Nothing to fix. This audit is already ready.</span></>;
  return <div className="whatif">
    <div className="row"><h2 className="grow">What if we fixed these?</h2><span className="sm dim">A projection only. A real verdict needs a new audit.</span></div>
    <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
      {kinds.map(k => { const n = res.findings.filter(f => f.status === 'confirmed' && f.kind === k).length; const sev = Math.min(...res.findings.filter(f => f.status === 'confirmed' && f.kind === k).map(f => f.severity));
        return <label key={k} className="check chipcheck"><input type="checkbox" checked={fixed.includes(k)} onChange={e => setFixed(e.target.checked ? [...fixed, k] : fixed.filter(x => x !== k))} /><span><span className={`pill s${sev}`}>S{sev}</span> {ACTION_FOR_KIND(k)?.[0] ?? k} <span className="dim">({n}) · {ACTION_FOR_KIND(k)?.[1] ?? ''}</span></span></label>; })}
      {offline.length > 0 && <label className="check chipcheck"><input type="checkbox" checked={restore} onChange={e => setRestore(e.target.checked)} /><span>Restore {offline.map(h => h.agent).join(', ')} and re-check</span></label>}
    </div>
    <div className="proj"><span className="sm dim2">Now</span><Verdict v={res.verdict} /><span aria-hidden="true">→</span><span className="sm dim2">Projected</span><Verdict v={proj.verdict} /><span className="sm grow">{proj.reason}</span></div>
  </div>;
}
