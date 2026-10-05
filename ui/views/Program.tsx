'use client';
// Program readiness: the whole program on one screen (PS 1.2 criterion 4), the program-wide blockers and
// "who can unblock what" (criterion 2), and chaos drills that break agents on purpose (criterion 3).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Verdict, when, fmt } from '../kit';
import type { ProgramOverview, ChaosPreset } from '../api';
import { CHAOS_PRESETS } from '../../lib/core/chaos';

const AGENT_SLOT: Record<string, number> = { Requirements: 1, Design: 2, Code: 3, Testing: 4, ConfigMgmt: 5 };
const AGENT_LABEL: Record<string, string> = { Requirements: 'Requirements', Design: 'Design', Code: 'Code', Testing: 'Testing', ConfigMgmt: 'Config Mgmt', Orchestrator: 'Orchestrator' };
const VERDICT_LABEL: Record<string, string> = { YES: 'Ready', CONDITIONAL: 'Conditional', NO: 'Not ready' };

export function ProgramView() {
  const { api, can, go, say, tick } = useApp();
  const [ds, setDs] = useState<string | undefined>(undefined);
  const { data, error, reload } = useLoad(() => api.program(ds), [tick, ds], 4000);
  const { data: sets } = useLoad(() => api.datasets(), []);
  const { busy, run } = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Building the program picture" />;
  const p = data; const c = p.counts;
  const auditAll = () => run('all', async () => { const r = await api.startAudits({ datasetId: p.dataset!.id, modules: ['*'], layer2: 'auto', faults: {} }); await reload(); return r; }, `Queued all ${c.modules} modules. The grid fills in as workers finish.`);
  return <>
    <Head title="Program readiness" eyebrow={p.dataset ? `${p.dataset.name} · baseline ${p.dataset.baseline} · ${fmt(p.dataset.total)} records` : 'No dataset'}
      actions={<>{(sets?.filter(d => d.status === 'ready').length ?? 0) > 1 && <select aria-label="Dataset" value={p.dataset?.id ?? ''} onChange={e => setDs(e.target.value)}>{sets!.filter(d => d.status === 'ready').map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
        {can('audit.request') && p.dataset && <button className="btn primary" disabled={busy === 'all'} onClick={auditAll}>Audit every module</button>}</>}>
      The latest audit of every module, the five agents' health and message traffic, what blocks certification and who can clear it. Updates every few seconds.
    </Head>

    <section className="kpis">
      <div className={`kpi hero vk-${p.program.verdict}`}>
        <span className="eyebrow">Program verdict</span>
        <div className="row" style={{ gap: 12 }}><Verdict v={p.program.verdict} lg /><b>{VERDICT_LABEL[p.program.verdict]}</b></div>
        <span className="sm dim2">{p.program.reason}</span>
      </div>
      <div className="kpi"><span className="eyebrow">Modules</span><ReadinessBar p={p} onPick={id => go(id)} /></div>
      <div className="kpi"><span className="eyebrow">Sign-off</span><span className="v">{c.approved}<small> / {c.modules}</small></span><span className="sm dim2">approved · {c.awaiting} waiting · {c.denied} denied</span></div>
      <div className="kpi"><span className="eyebrow">Agent faults, latest audits</span><span className="v">{p.agents.reduce((n, a) => n + a.retries, 0)}<small> retries</small></span>
        <span className="sm dim2">{p.agents.reduce((n, a) => n + a.breakerTrips, 0)} breaker trips · {p.agents.reduce((n, a) => n + a.offline, 0)} offline · {p.flow.rejected} rejected messages</span></div>
    </section>

    <div className="panel">
      <div className="row"><h2 className="grow">Every module</h2><span className="sm dim">Grouped by DAL. Click a module for its report.</span></div>
      <ModuleGrid p={p} onPick={id => go(id)} />
    </div>

    <div className="grid2">
      <div className="panel"><Blockers p={p} onPick={id => go(id)} /></div>
      <div className="panel"><Owners p={p} /></div>
    </div>

    <div className="grid2">
      <div className="panel"><div className="row"><h2 className="grow">Agent latency, p95 in ms, per audit</h2></div><LatencyChart p={p} /></div>
      <div className="panel"><AgentTable p={p} /></div>
    </div>

    <div className="grid2">
      <div className="panel"><div className="row"><h2 className="grow">Message flow between agents</h2><span className="sm dim">{fmt(p.flow.total)} messages · {p.flow.rejected} rejected</span></div><FlowMatrix p={p} /></div>
      <div className="panel"><Chaos p={p} onRun={id => go(id)} canRun={can('audit.request')} say={say} /></div>
    </div>

    <div className="grid2">
      <div className="panel"><h2>Audits per day, by verdict</h2><DailyVerdicts p={p} /></div>
      <div className="panel"><h2>Retries per day</h2><DailyRetries p={p} /></div>
    </div>
    <small className="dim">Generated {when(p.generatedAt)}. Verdicts and projections use the same fixed rule as every audit: any open severity-1 finding means NO; other findings mean CONDITIONAL; an offline agent can't give YES.</small>
  </>;
}

// ---------- pieces ----------
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null); const [w, setW] = useState(600);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(e => setW(Math.max(260, Math.floor(e[0].contentRect.width)))); ro.observe(el); return () => ro.disconnect(); }, []);
  return [ref, w];
}
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const show = (e: React.MouseEvent | React.FocusEvent, body: ReactNode) => {
    const r = host.current?.getBoundingClientRect(); if (!r) return;
    const pt = 'clientX' in e ? { x: e.clientX - r.left, y: e.clientY - r.top } : (() => { const b = (e.target as Element).getBoundingClientRect(); return { x: b.left - r.left + b.width / 2, y: b.top - r.top }; })();
    setTip({ ...pt, body });
  };
  const el = tip && <div className="viz-tip" role="status" style={{ left: Math.min(tip.x + 12, (host.current?.clientWidth ?? 400) - 220), top: Math.max(tip.y - 12, 0) }}>{tip.body}</div>;
  return { host, show, hide: () => setTip(null), el };
}
const niceMax = (v: number) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const roundTop = (x: number, y: number, w: number, h: number, r = 4) => { const rr = Math.min(r, w / 2, h); return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`; };

function ReadinessBar({ p, onPick }: { p: ProgramOverview; onPick: (id: string) => void }) {
  const c = p.counts; const tip = useTip();
  const parts = [['NO', c.NO, 'Not ready'], ['CONDITIONAL', c.CONDITIONAL, 'Conditional'], ['YES', c.YES, 'Ready'], ['pending', c.running + c.failed + c.notAudited, 'No finished audit']] as const;
  return <div ref={tip.host} className="viz-host">
    <div className="rbar" role="img" aria-label={parts.map(x => `${x[1]} ${x[2]}`).join(', ')}>
      {parts.filter(x => x[1] > 0).map(([k, n, l]) => <span key={k} className={`seg st-${k}`} style={{ flexGrow: n }} tabIndex={0}
        onMouseMove={e => tip.show(e, <><b>{n} {l.toLowerCase()}</b><div className="dim">{p.modules.filter(m => (k === 'pending' ? !m.verdict : m.verdict === k)).slice(0, 8).map(m => m.id).join(', ')}{n > 8 ? '…' : ''}</div></>)}
        onFocus={e => tip.show(e, <b>{n} {l.toLowerCase()}</b>)} onMouseLeave={tip.hide} onBlur={tip.hide}
        onClick={() => { const m = p.modules.find(m => (k === 'pending' ? !m.verdict : m.verdict === k) && m.runId); if (m?.runId) onPick(m.runId); }} />)}
    </div>
    <div className="rlegend">{parts.map(([k, n, l]) => <span key={k}><i className={`sw st-${k}`} />{l} <b>{n}</b></span>)}</div>
    {tip.el}
  </div>;
}

function ModuleGrid({ p, onPick }: { p: ProgramOverview; onPick: (id: string) => void }) {
  const tip = useTip();
  const dals = [...new Set(p.modules.map(m => m.dal))].sort();
  return <div ref={tip.host} className="viz-host mgrid-wrap">
    {dals.map(d => <div key={d} className="mgroup"><span className="mdal">DAL {d}</span><div className="mgrid">
      {p.modules.filter(m => m.dal === d).map(m => {
        const st = m.verdict ?? (m.status === 'queued' || m.status === 'running' ? 'running' : m.status === 'failed' ? 'failed' : 'pending');
        return <button key={m.id} className={`mcell st-${st}`} disabled={!m.runId} onClick={() => m.runId && onPick(m.runId)}
          onMouseMove={e => tip.show(e, <><b>{m.id} · {m.name}</b><div>{m.verdict ? `${VERDICT_LABEL[m.verdict]} · ${m.s1} severity-1 · ${m.findings} findings` : m.status === 'not_audited' ? 'Not audited yet' : m.status}</div>{m.at && <div className="dim">{when(m.at)}{m.trigger === 'schedule' ? ' · scheduled' : ''} · {m.status.replace('_', ' ')}</div>}</>)}
          onMouseLeave={tip.hide} aria-label={`${m.id}: ${m.verdict ?? m.status}`}>
          <span className="mid">{m.id}</span><span className="mv">{m.verdict === 'CONDITIONAL' ? 'COND' : m.verdict ?? (st === 'running' ? '…' : st === 'failed' ? 'FAIL' : '–')}</span>
          {m.status === 'approved' && <span className="mok" title="Approved">✓</span>}
        </button>;
      })}
    </div></div>)}
    {tip.el}
  </div>;
}

function Blockers({ p, onPick }: { p: ProgramOverview; onPick: (id: string) => void }) {
  const [owner, setOwner] = useState('');
  const list = p.blockers.filter(b => !owner || b.owner === owner);
  const owners = [...new Set(p.blockers.map(b => b.owner))];
  return <>
    <div className="row"><h2 className="grow">What blocks certification</h2>
      <select aria-label="Filter by owner" value={owner} onChange={e => setOwner(e.target.value)}><option value="">All owners</option>{owners.map(o => <option key={o}>{o}</option>)}</select></div>
    <p className="sm dim2" style={{ margin: 0 }}>Every next action from modules that aren't ready, ranked: critical path first, then severity, then DAL.</p>
    {!list.length ? <div className="empty">Nothing blocking{owner ? ` for ${owner}` : ''}.</div> :
      <ol className="blockers">{list.slice(0, 14).map((b, i) => <li key={i}>
        <span className="rank">{i + 1}</span>
        <div className="grow"><div><button className="link-btn" onClick={() => onPick(b.runId)}>{b.module}</button> <span className="dim sm">DAL {b.dal}</span> {b.onCriticalPath && <span className="pill bad">Critical path</span>} <span className={`pill s${b.severity}`}>S{b.severity}</span></div>
          <div className="sm">{b.action} <span className="dim">({b.count})</span></div></div>
        <span className="sm dim2 owner">{b.owner}</span>
      </li>)}</ol>}
    {list.length > 14 && <small className="dim">{list.length - 14} more.</small>}
  </>;
}

function Owners({ p }: { p: ProgramOverview }) {
  const start = { NO: p.counts.NO, CONDITIONAL: p.counts.CONDITIONAL, YES: p.counts.YES };
  return <>
    <h2>Fastest way to unblock</h2>
    <p className="sm dim2" style={{ margin: 0 }}>Most NO modules have blockers from several owners, so no single team flips them alone. For each team size, this is the combination of owners that moves the most modules if they cleared their items, using the same verdict rule as the audits.</p>
    {!p.plan.length ? <div className="empty">{p.blockers.length ? 'No combination of owners changes a verdict on its own.' : 'No open items.'}</div> : <ol className="plan">
      <li className="sm dim2"><span className="pstep">Now</span><span className="grow" /><Counts c={start} /></li>
      {p.plan.map(s => { const teams = s.owners;
        return <li key={teams.join('|')}><span className="pstep">{teams.length} {teams.length > 1 ? 'teams' : 'team'}</span><div className="grow"><b>{teams.length > 3 ? `All ${teams.length} owners` : teams.join(', ')}</b>
          <div className="sm dim">{teams.reduce((n, t) => n + (p.owners.find(o => o.owner === t)?.items ?? 0), 0)} items between them</div></div><Counts c={s} /></li>; })}
    </ol>}
    <h3>Per owner</h3>
    <ul className="owners">{p.owners.slice(0, 6).map(o => <li key={o.owner}><div className="row" style={{ gap: 8 }}><b className="grow">{o.owner}</b><span className="sm dim">{o.items} items · {o.modules} modules{o.s1 ? ` · ${o.s1} severity-1` : ''}</span></div></li>)}</ul>
  </>;
}
function Counts({ c }: { c: { NO: number; CONDITIONAL: number; YES: number } }) {
  return <span className="counts"><span className="pill bad" title="Not ready">{c.NO} NO</span><span className="pill warn" title="Conditional">{c.CONDITIONAL} COND</span><span className="pill ok" title="Ready">{c.YES} YES</span></span>;
}

function LatencyChart({ p }: { p: ProgramOverview }) {
  const [ref, w] = useWidth<HTMLDivElement>(); const tip = useTip(); const [table, setTable] = useState(false); const [hover, setHover] = useState<number | null>(null);
  const series = p.agents.filter(a => a.series.length);
  const n = Math.max(0, ...series.map(s => s.series.length));
  if (!n) return <div className="empty">No finished audits yet.</div>;
  const H = 230, L = 44, R = 96, T = 12, B = 26; const iw = w - L - R, ih = H - T - B;
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.series.map(x => x.p95))));
  const x = (i: number) => L + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); const y = (v: number) => T + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const base = series[0].series;
  // Direct labels at the line ends, nudged apart so they don't collide.
  const ends = series.map(s => ({ a: s.agent, y: y(s.series.at(-1)!.p95) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect(); const px = e.clientX - r.left;
    const i = Math.max(0, Math.min(n - 1, Math.round((px / r.width) * (n - 1)))); setHover(i);
    tip.show(e, <><b>{base[i]?.module}</b> <span className="dim">{when(base[i]?.at)}</span>
      {series.map(s => <div key={s.agent} className="trow"><i className={`sw s-${AGENT_SLOT[s.agent]}`} />{AGENT_LABEL[s.agent]}<span className="grow" /><b>{s.series[i]?.p95 ?? '–'} ms</b>{s.series[i]?.retries ? <span className="dim"> · {s.series[i].retries} retries</span> : null}</div>)}</>);
  };
  return <div ref={ref} className="viz-host">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <div className="legend">{series.map(s => <span key={s.agent}><i className={`sw s-${AGENT_SLOT[s.agent]}`} />{AGENT_LABEL[s.agent]}</span>)}</div>
      <button className="btn sm ghost" onClick={() => setTable(t => !t)} aria-pressed={table}>{table ? 'Chart' : 'Table'}</button>
    </div>
    {table ? <div className="tbl"><table><thead><tr><th>Audit</th>{series.map(s => <th key={s.agent}>{AGENT_LABEL[s.agent]}</th>)}</tr></thead><tbody>
      {base.map((b, i) => <tr key={b.runId}><td className="sm">{b.module} <span className="dim">{when(b.at)}</span></td>{series.map(s => <td key={s.agent} className="num">{s.series[i]?.p95 ?? '–'} ms</td>)}</tr>).reverse()}</tbody></table></div> :
    <div ref={tip.host} className="viz-host">
      <svg width={w} height={H} role="img" aria-label="p95 latency per agent across recent audits">
        {ticks.map(t => <g key={t}><line x1={L} x2={L + iw} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 6} y={y(t) + 4} className="axis" textAnchor="end">{Math.round(t)}</text></g>)}
        <text x={L} y={H - 6} className="axis">older</text><text x={L + iw} y={H - 6} className="axis" textAnchor="end">latest audit</text>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ih} className="crosshair" />}
        {series.map(s => <path key={s.agent} className={`line s-${AGENT_SLOT[s.agent]}`} d={s.series.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v.p95).toFixed(1)}`).join('')} />)}
        {hover !== null && series.map(s => s.series[hover] && <circle key={s.agent} cx={x(hover)} cy={y(s.series[hover].p95)} r={4} className={`dot s-${AGENT_SLOT[s.agent]}`} />)}
        {ends.map(e => <text key={e.a} x={L + iw + 8} y={e.y + 4} className="dlabel">{AGENT_LABEL[e.a]}</text>)}
        <rect x={L} y={T} width={iw} height={ih} fill="transparent" onMouseMove={onMove} onMouseLeave={() => { setHover(null); tip.hide(); }} />
      </svg>{tip.el}
    </div>}
  </div>;
}

function AgentTable({ p }: { p: ProgramOverview }) {
  return <>
    <h2>Agent health, latest audit of each module</h2>
    <div className="tbl"><table><thead><tr><th>Agent</th><th>Healthy</th><th>Degraded</th><th>Offline</th><th>Retries</th><th>Breaker trips</th><th>p95 median</th></tr></thead><tbody>
      {p.agents.map(a => <tr key={a.agent}><td style={{ whiteSpace: "nowrap" }}><i className={`sw s-${AGENT_SLOT[a.agent]}`} /> <b style={{ fontWeight: 600 }}>{AGENT_LABEL[a.agent]}</b></td>
        <td className="num">{a.healthy}</td><td className="num">{a.degraded ? <span className="pill warn">{a.degraded}</span> : 0}</td><td className="num">{a.offline ? <span className="pill bad">{a.offline}</span> : 0}</td>
        <td className="num">{a.retries}</td><td className="num">{a.breakerTrips}</td><td className="num">{a.p95Median} ms</td></tr>)}
    </tbody></table></div>
    {p.faults.length > 0 && <><h3>Recent faults and recovery</h3><ul className="faults">{p.faults.slice(0, 6).map((f, i) => <li key={i} className="sm">
      <b>{AGENT_LABEL[f.agent]}</b> on {f.module}: {f.state}{f.retries ? `, ${f.retries} retries` : ''}{f.breaker !== 'closed' ? `, breaker ${f.breaker}` : ''}{Object.keys(f.faults).length ? <span className="pill acc" style={{ marginLeft: 6 }}>drill</span> : null} <span className="dim">{when(f.at)}</span></li>)}</ul></>}
  </>;
}

const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
function FlowMatrix({ p }: { p: ProgramOverview }) {
  const tip = useTip(); const a = p.flow.actors;
  const get = (f: string, t: string) => p.flow.cells.find(c => c.from === f && c.to === t);
  const max = Math.max(1, ...p.flow.cells.map(c => c.count));
  if (!p.flow.total) return <div className="empty">No messages yet.</div>;
  return <div ref={tip.host} className="viz-host">
    <div className="fmatrix" style={{ gridTemplateColumns: `minmax(86px,auto) repeat(${a.length}, minmax(34px,1fr))` }} role="table" aria-label="Messages from each sender (rows) to each receiver (columns)">
      <span className="fh corner">from ↓ to →</span>{a.map(t => <span key={t} className="fh">{AGENT_LABEL[t].replace('Config Mgmt', 'CM').replace('Orchestrator', 'Orch.')}</span>)}
      {a.map(f => <FlowRow key={f} f={f} a={a} get={get} max={max} tip={tip} />)}
    </div>
    <div className="seqlegend"><span className="dim sm">fewer</span>{SEQ.map(c => <i key={c} style={{ background: c }} />)}<span className="dim sm">more</span><span className="dim sm" style={{ marginLeft: 12 }}>Broadcasts are counted as to the Orchestrator.</span></div>
    {tip.el}
  </div>;
}
function FlowRow({ f, a, get, max, tip }: { f: string; a: string[]; get: (f: string, t: string) => ProgramOverview['flow']['cells'][number] | undefined; max: number; tip: ReturnType<typeof useTip> }) {
  return <>
    <span className="fh row-h">{AGENT_LABEL[f]}</span>
    {a.map(t => { const c = get(f, t); const k = c ? Math.min(SEQ.length - 1, Math.floor((Math.sqrt(c.count) / Math.sqrt(max)) * (SEQ.length - 1) + 0.5)) : -1;
      return <span key={t} className={'fcell' + (c ? '' : ' empty')} tabIndex={c ? 0 : -1} style={c ? { background: SEQ[k], color: k >= 3 ? '#fff' : '#0b0b0b' } : undefined}
        onMouseMove={e => c && tip.show(e, <><b>{AGENT_LABEL[f]} → {AGENT_LABEL[t]}</b><div>{c.count} messages{c.rejected ? `, ${c.rejected} rejected` : ''}</div><div className="dim">{Object.entries(c.byType).map(([k2, v]) => `${k2} ${v}`).join(' · ')}</div></>)} onMouseLeave={tip.hide}>
        {c ? c.count : ''}{c?.rejected ? <sup className="rej">!</sup> : null}</span>; })}
  </>;
}

function DailyVerdicts({ p }: { p: ProgramOverview }) {
  const [ref, w] = useWidth<HTMLDivElement>(); const tip = useTip();
  const H = 180, L = 30, R = 8, T = 10, B = 24; const iw = w - L - R, ih = H - T - B; const n = p.daily.length;
  const max = niceMax(Math.max(1, ...p.daily.map(d => d.YES + d.CONDITIONAL + d.NO)));
  const bw = Math.max(4, iw / n - 6); const x = (i: number) => L + i * (iw / n) + (iw / n - bw) / 2; const hh = (v: number) => (v / max) * ih;
  return <div ref={ref} className="viz-host"><div ref={tip.host} className="viz-host">
    <div className="legend"><span><i className="sw st-YES" />Ready</span><span><i className="sw st-CONDITIONAL" />Conditional</span><span><i className="sw st-NO" />Not ready</span></div>
    <svg width={w} height={H} role="img" aria-label="Audits per day by verdict">
      {[0, max].map(t => <g key={t}><line x1={L} x2={L + iw} y1={T + ih - hh(t)} y2={T + ih - hh(t)} className="grid" /><text x={L - 6} y={T + ih - hh(t) + 4} className="axis" textAnchor="end">{t}</text></g>)}
      {p.daily.map((d, i) => { let acc = 0; const segs = (['NO', 'CONDITIONAL', 'YES'] as const).filter(k => d[k] > 0);
        return <g key={d.day} onMouseMove={e => tip.show(e, <><b>{d.day}</b><div>{d.runs} audits · {d.NO} NO · {d.CONDITIONAL} conditional · {d.YES} YES</div>{d.failed ? <div>{d.failed} failed to run</div> : null}</>)} onMouseLeave={tip.hide}>
          <rect x={x(i) - 3} y={T} width={bw + 6} height={ih} fill="transparent" />
          {segs.map((k, j) => { const h = hh(d[k]); const y0 = T + ih - acc - h; acc += h + 2; const top = j === segs.length - 1;
            return top ? <path key={k} d={roundTop(x(i), y0, bw, Math.max(1, h))} className={`bar st-${k}`} /> : <rect key={k} x={x(i)} y={y0} width={bw} height={Math.max(1, h)} className={`bar st-${k}`} />; })}
          {(i === 0 || i === n - 1 || i % 7 === 0) && <text x={x(i) + bw / 2} y={H - 6} className="axis" textAnchor="middle">{d.day.slice(5)}</text>}
        </g>; })}
    </svg>{tip.el}
  </div></div>;
}
function DailyRetries({ p }: { p: ProgramOverview }) {
  const [ref, w] = useWidth<HTMLDivElement>(); const tip = useTip();
  const H = 180, L = 30, R = 8, T = 10, B = 24; const iw = w - L - R, ih = H - T - B; const n = p.daily.length;
  const max = niceMax(Math.max(1, ...p.daily.map(d => d.retries)));
  const bw = Math.max(4, iw / n - 6); const x = (i: number) => L + i * (iw / n) + (iw / n - bw) / 2;
  return <div ref={ref} className="viz-host"><div ref={tip.host} className="viz-host">
    <div className="legend"><span className="dim sm">Message retries across all agents. Spikes line up with chaos drills or flaky agents.</span></div>
    <svg width={w} height={H} role="img" aria-label="Retries per day">
      {[0, max].map(t => <g key={t}><line x1={L} x2={L + iw} y1={T + ih - (t / max) * ih} y2={T + ih - (t / max) * ih} className="grid" /><text x={L - 6} y={T + ih - (t / max) * ih + 4} className="axis" textAnchor="end">{t}</text></g>)}
      {p.daily.map((d, i) => { const h = (d.retries / max) * ih; return <g key={d.day} onMouseMove={e => tip.show(e, <><b>{d.day}</b><div>{d.retries} retries over {d.runs} audits</div></>)} onMouseLeave={tip.hide}>
        <rect x={x(i) - 3} y={T} width={bw + 6} height={ih} fill="transparent" />
        {d.retries > 0 && <path d={roundTop(x(i), T + ih - h, bw, Math.max(1, h))} className="bar s-1" />}
        {(i === 0 || i === n - 1 || i % 7 === 0) && <text x={x(i) + bw / 2} y={H - 6} className="axis" textAnchor="middle">{d.day.slice(5)}</text>}
      </g>; })}
    </svg>{tip.el}
  </div></div>;
}

function Chaos({ p, onRun, canRun, say }: { p: ProgramOverview; onRun: (id: string) => void; canRun: boolean; say: (t: string, e?: boolean) => void }) {
  const { api } = useApp(); const { busy, run } = useAction();
  const mods = useMemo(() => p.modules.map(m => m.id), [p.modules]);
  const [mod, setMod] = useState(mods.includes('BARO-IN') ? 'BARO-IN' : mods[0] ?? '');
  return <>
    <div className="row"><h2 className="grow">Chaos drill</h2><span className="pill acc">Robustness</span></div>
    <p className="sm dim2" style={{ margin: 0 }}>Break agents on purpose during a real audit and watch retries, circuit breakers and recovery in the live message trail. Drills are tagged in the audit log.</p>
    <div className="row"><label className="sm" htmlFor="cm">Module</label><select id="cm" value={mod} onChange={e => setMod(e.target.value)}>{mods.map(m => <option key={m}>{m}</option>)}</select></div>
    <div className="drills">{(Object.entries(CHAOS_PRESETS) as [ChaosPreset, typeof CHAOS_PRESETS[ChaosPreset]][]).map(([id, d]) => <div key={id} className="drill">
      <div className="row" style={{ gap: 8 }}><b className="grow">{d.label}</b>
        <button className="btn sm" disabled={!canRun || !!busy || !mod} onClick={() => run(id, async () => { const r = await api.chaosDrill(mod, id, p.dataset?.id); say(`Drill started on ${mod}. Watch the agents react.`); onRun(r.runId); })}>{busy === id ? 'Starting…' : 'Run drill'}</button></div>
      <span className="sm dim2">{d.expect}</span>
    </div>)}</div>
    {!canRun && <small className="dim">You need permission to start audits to run a drill.</small>}
  </>;
}
