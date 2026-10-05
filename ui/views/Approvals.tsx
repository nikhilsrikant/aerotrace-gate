'use client';
import { useCallback, useEffect, useState } from 'react';
import { useApp, useLoad, Verdict, Head, Empty, Loading, ErrorBox, ago } from '../kit';
import { AutomationSuggestions } from './Suggestions';
import { Steps, Trigger } from './parts';
import type { RunView } from '../../lib/core/services';
import { AGENT_LABEL } from '../../lib/engine/types';

const REASONS = ['Evidence incomplete', 'Disputed findings unresolved', 'Re-run on new baseline'];

export function Approvals() {
  const { api, say, go, can, bump, tick } = useApp();
  const { data, error, reload } = useLoad(() => api.inbox(), [tick], 5000);
  const [tab, setTab] = useState<'mine' | 'others'>('mine');
  const [sel, setSel] = useState(0);
  const [reason, setReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const list = data ? (tab === 'mine' ? data.mine : data.others) : [];
  const act = useCallback(async (r: RunView, a: 'approve' | 'deny') => {
    if (a === 'deny' && r.approval.denyRequiresReason && !reason[r.id]?.trim()) { say(`Policy "${r.approval.policyName}" asks for a reason when denying. Pick or type one first.`, true); return; }
    setBusy(r.id + a);
    try { const res = await api.decide(r.id, a, a === 'deny' ? reason[r.id] : undefined); say(a === 'deny' ? `${r.module} denied. Signed and logged.` : res.status === 'approved' ? `${r.module} fully approved. Signed and logged.` : `Signed. ${res.approval.waitingOn}.`); await reload(); bump(); }
    catch (e) { say(e instanceof Error ? e.message : String(e), true); } finally { setBusy(null); }
  }, [api, reason, reload, say, bump]);
  useEffect(() => {
    if (tab !== 'mine') return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (/INPUT|SELECT|TEXTAREA/.test(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const r = list[sel]; if (!r) return;
      if (e.key === 'j') setSel(s => Math.min(list.length - 1, s + 1)); else if (e.key === 'k') setSel(s => Math.max(0, s - 1));
      else if (e.key === 'a') act(r, 'approve'); else if (e.key === 'd') act(r, 'deny'); else if (e.key === 'Enter' && t.tagName !== 'BUTTON') go(r.id);
    };
    addEventListener('keydown', on); return () => removeEventListener('keydown', on);
  }, [list, sel, act, go, tab]);
  useEffect(() => { if (sel >= list.length) setSel(Math.max(0, list.length - 1)); }, [list.length, sel]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Loading your approvals" />;
  const rank = { NO: 0, CONDITIONAL: 1, YES: 2 } as Record<string, number>;
  list.sort((a, b) => (rank[a.verdict ?? ''] ?? 3) - (rank[b.verdict ?? ''] ?? 3) || b.createdAt.localeCompare(a.createdAt));
  return <>
    <Head title={data.mine.length ? `${data.mine.length} audit${data.mine.length > 1 ? 's' : ''} waiting on you` : 'Nothing waiting on you'}
      actions={tab === 'mine' && list.length ? <span className="dim sm"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>A</kbd> approve · <kbd>D</kbd> deny · <kbd>Enter</kbd> open</span> : undefined}>
      You only see the audits whose current approval step you are allowed to sign, directly or through a delegation. Approval policies decide that, not your job title.
    </Head>
    <AutomationSuggestions compact />
    <div className="tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>Waiting on you ({data.mine.length})</button>
      {can('audit.view') && <button role="tab" aria-selected={tab === 'others'} onClick={() => setTab('others')}>Waiting on others ({data.others.length})</button>}
    </div>
    {!list.length && (tab === 'mine' ? <Empty title="Your queue is clear.">{can('audit.request') && <button className="btn primary" onClick={() => go('new')}>Run an audit</button>}</Empty> : <Empty title="No other audits are waiting." />)}
    <div className="inbox">
      {list.map((r, i) => {
        const s = r.summary;
        return <article key={r.id} className={`card vc-${r.verdict}` + (i === sel && tab === 'mine' ? ' sel' : '')} onMouseEnter={() => setSel(i)} aria-label={`${r.module} audit, verdict ${r.verdict}`}>
          <div className="stripe" />
          <div className="body">
            <div className="title"><Verdict v={r.verdict} /><b>{r.module}</b><span className="dim2">{r.moduleName}</span><span className="pill">DAL {r.dal}</span><Trigger r={r} />
              {s && !s.complete && <span className="pill bad">Incomplete</span>}</div>
            <div className="dim2">{r.verdictReason}</div>
            {s && <div className="row" style={{ gap: 6 }}>
              {s.counts.s1 > 0 && <span className="pill s1">{s.counts.s1} severity 1</span>}
              {s.counts.s2 > 0 && <span className="pill s2">{s.counts.s2} severity 2</span>}
              {s.counts.s3 > 0 && <span className="pill s3">{s.counts.s3} severity 3</span>}
              <span className="pill acc">Layer 1: {s.counts.l1}</span><span className="pill acc">Layer 2: {s.counts.l2}</span>
              {s.counts.disputed > 0 && <span className="pill warn">{s.counts.disputed} disputed by Layer 2</span>}
            </div>}
            {s && s.top.length > 0 && <ul className="tops">{s.top.map((t, k) => <li key={k}><span className={`pill s${t.severity}`}>S{t.severity}</span><span className="dim" style={{ minWidth: 86 }}>{AGENT_LABEL[t.agent]}</span><span>{t.title}</span></li>)}</ul>}
            <Steps a={r.approval} compact />
            <div className="meta"><span>{r.approval.policyName} v{r.approval.policyVersion}</span><span>Requested by {r.requestedByName} · {ago(r.createdAt)}</span><span className="mono">report {r.reportHash?.slice(0, 12)}</span>
              <button className="btn sm" onClick={() => go(r.id)}>Open full report</button></div>
          </div>
          {tab === 'mine' ? <div className="act">
            <div className="sm dim2">You sign <b>{r.approval.myStep}</b>{r.approval.onBehalfOf ? <> for <b>{r.approval.onBehalfOf}</b></> : null}</div>
            <button className="btn approve" disabled={!!busy} onClick={() => act(r, 'approve')}>{busy === r.id + 'approve' && <span className="spin sm" />}Approve</button>
            <button className="btn deny" disabled={!!busy} onClick={() => act(r, 'deny')}>Deny</button>
            <div className="reasons" aria-label="Reason for a denial">
              {REASONS.map(x => <button key={x} aria-pressed={reason[r.id] === x} onClick={() => setReason(st => ({ ...st, [r.id]: st[r.id] === x ? '' : x }))}>{x}</button>)}
            </div>
            {r.approval.denyRequiresReason && <small className="dim">Denying needs a reason under this policy.</small>}
          </div> : <div className="act"><span className="sm dim2">{r.approval.waitingOn}</span></div>}
        </article>;
      })}
    </div>
  </>;
}
