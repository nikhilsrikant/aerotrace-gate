'use client';
import { useEffect, useRef } from 'react';
import type { ApprovalView, RunView } from '../../lib/core/services';
import type { A2AMessage, AgentHealth, AgentName, Finding } from '../../lib/engine/types';
import { AGENT_LABEL } from '../../lib/engine/types';
import { when } from '../kit';

export function Steps({ a, compact }: { a: ApprovalView; compact?: boolean }) {
  if (a.status === 'no_policy') return <div className="steps"><span className="pill bad">No approval policy covers this audit</span></div>;
  return <ol className={'steps' + (compact ? ' compact' : '')} aria-label="Approval steps">
    {a.steps.map((s, i) => {
      const state = s.satisfied ? 'done' : s.open ? 'open' : a.status === 'denied' ? 'stopped' : 'later';
      return <li key={s.id} className={`step ${state}`}>
        <span className="dot" aria-hidden="true">{s.satisfied ? '✓' : i + 1}</span>
        <div>
          <b>{s.name}</b> <span className="dim">{s.approvals.length}/{s.min}</span>
          {s.approvals.map((x, k) => <div key={k} className="dim2 sm">{x.by}{x.onBehalfOf ? ` for ${x.onBehalfOf}` : ''} · {when(x.at)}</div>)}
          {!compact && s.open && <div className="sm dim">Can sign: {s.eligible.length ? s.eligible.map(e => e.name + (e.via === 'delegation' ? ' (delegate)' : '')).join(', ') : 'nobody right now'}</div>}
          {state === 'later' && !compact && <div className="sm dim">After step {i}</div>}
        </div>
      </li>;
    })}
  </ol>;
}

export function Trigger({ r }: { r: Pick<RunView, 'trigger' | 'scheduleId'> }) {
  return r.trigger === 'schedule' ? <span className="pill acc" title="Started by a schedule">Scheduled</span> : r.trigger === 'api' ? <span className="pill acc">API</span> : null;
}

export function HealthGrid({ health }: { health: AgentHealth[] }) {
  return <div className="health">{health.map(h => <div key={h.agent} className={`hc ${h.state}`}>
    <b>{AGENT_LABEL[h.agent]}</b><span className="st">{h.state === 'healthy' ? 'Healthy' : h.state === 'degraded' ? 'Degraded · recovered' : 'Offline'}</span>
    <span className="kv"><span>attempts · retries</span><span>{h.attempts} · {h.retries}</span></span>
    <span className="kv"><span>breaker</span><span>{h.breaker}</span></span>
    <span className="kv"><span>p95 step</span><span>{h.p95Ms ? `${h.p95Ms} ms` : '–'}</span></span>
    <span className="kv"><span>messages</span><span>{h.messages}</span></span></div>)}</div>;
}

export function Trail({ messages, follow }: { messages: A2AMessage[]; follow?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const t0 = messages[0]?.ts ?? 0;
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [messages.length, follow]);
  const brief = (m: A2AMessage) => {
    const p = m.payload as Record<string, unknown>;
    return String(p.text ?? p.title ?? p.impact ?? p.needs ?? (m.type === 'request' ? `audit ${p.scope} · DAL ${p.dal} · baseline ${p.baseline}` : m.type === 'result' ? `${p.count} findings${p.verdict ? ` · verdict ${p.verdict}` : ''}` : m.type === 'heartbeat' ? (p.done ? 'done' : 'alive') : ''));
  };
  return <div className="trail" ref={ref} role="log" aria-label="Agent message trail">
    {messages.map(m => <div key={m.id + m.hash}><span className="dim">+{((m.ts - t0) / 1000).toFixed(2)}s </span> <span className={`t t-${m.type}`}>{m.type}</span>{' '}
      {AGENT_LABEL[m.from as AgentName] ?? m.from} → {m.to === '*' ? 'all' : AGENT_LABEL[m.to as AgentName] ?? m.to}{'  '}
      {m.accepted ? <span>{brief(m)}</span> : <span className="rej">REJECTED: {m.reason}</span>}{'  '}<span className="dim">#{m.hash.slice(0, 8)}</span></div>)}
  </div>;
}

export function FindingsTable({ findings, focus }: { findings: Finding[]; focus?: string | null }) {
  if (!findings.length) return <div className="empty">No findings in this view.</div>;
  return <div className="tbl"><table><thead><tr><th>Sev</th><th>Layer</th><th>Finding</th><th>Agent</th><th>Objective</th><th>Evidence</th></tr></thead><tbody>
    {findings.map(f => <tr key={f.id} id={'f-' + f.id} className={(f.status === 'rejected' ? 'rejected' : '') + (focus === f.id ? ' row-focus' : '')}>
      <td><span className={`pill s${f.severity}`}>S{f.severity}</span></td>
      <td><span className="pill acc">{f.layer}</span>{f.status !== 'confirmed' && <div style={{ marginTop: 4 }}><span className={`pill ${f.status === 'disputed' ? 'warn' : 'bad'}`}>{f.status}</span></div>}</td>
      <td style={{ minWidth: 260 }}><b style={{ fontWeight: 600 }}>{f.title}</b><div className="dim2 sm">{f.detail}</div>
        {f.dispute && <div className="sm" style={{ marginTop: 4, color: f.status === 'disputed' ? 'var(--warn)' : 'var(--bad)' }}>{f.status === 'disputed' ? 'Layer 2: ' : 'Cross-check: '}{f.dispute}</div>}
        <div className="dim mono" style={{ fontSize: 11 }}>{f.id} · {f.rule} · owner {f.owner}</div></td>
      <td>{AGENT_LABEL[f.agent]}</td><td className="num">Table {f.objective}</td>
      <td className="ev">{f.citations.map((c, i) => <div key={i}>{c.path}{c.quote ? <> <span className="quote">{c.quote}</span></> : null}</div>)}</td>
    </tr>)}</tbody></table></div>;
}
