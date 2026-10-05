'use client';
import { useState } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, when } from '../kit';
import type { AuditEvent } from '../../lib/core/model';

export function AuditLog() {
  const { api, go } = useApp();
  const [before, setBefore] = useState<number | undefined>(undefined);
  const [rows, setRows] = useState<AuditEvent[]>([]);
  const { error } = useLoad(async () => { const r = await api.auditLog(100, before); setRows(x => before ? [...x, ...r] : r); return r; }, [before]);
  const [v, setV] = useState<{ ok: boolean; checked: number; reason?: string } | null>(null);
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const shown = rows.filter(e => !q || `${e.action} ${e.actorName} ${e.target} ${JSON.stringify(e.details)}`.toLowerCase().includes(q.toLowerCase()));
  return <>
    <Head title="Audit log" actions={<button className="btn" disabled={busy === 'v'} onClick={() => run('v', async () => setV(await api.verifyAuditLog()))}>Verify the whole chain</button>}>
      Every sign-in, permission change, policy edit, schedule run and decision, in order. Each entry is hashed together with the one before it, and the database refuses edits and deletes, so a gap or a change shows up when you verify.
    </Head>
    {v && <div className={`panel ${v.ok ? 'okbox' : 'badbox'}`}><b>{v.ok ? `Intact: ${v.checked} events verified.` : `Broken: ${v.reason}`}</b></div>}
    <input aria-label="Filter" placeholder="Filter by action, person or target" value={q} onChange={e => setQ(e.target.value)} className="filter" />
    {error ? <ErrorBox error={error} /> : !rows.length ? <Loading /> :
      <div className="tbl"><table><thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>Hash</th></tr></thead><tbody>
        {shown.map(e => <tr key={e.seq}><td className="num">{e.seq}</td><td className="sm num">{when(e.at)}</td><td>{e.actorName}</td><td className="mono sm">{e.action}</td>
          <td className="mono sm">{e.target.startsWith('run_') ? <button className="btn sm" onClick={() => go(e.target)}>{e.target}</button> : e.target}</td>
          <td className="sm dim2" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{Object.entries(e.details).filter(([, x]) => x !== null && x !== undefined && x !== '').slice(0, 5).map(([k, x]) => `${k}: ${typeof x === 'object' ? JSON.stringify(x).slice(0, 60) : String(x).slice(0, 60)}`).join(' · ')}</td>
          <td className="mono dim sm">{e.hash.slice(0, 10)}</td></tr>)}
      </tbody></table></div>}
    {rows.length >= 100 && rows.length % 100 === 0 && <button className="btn" style={{ alignSelf: 'start' }} onClick={() => setBefore(rows.at(-1)!.seq)}>Load older</button>}
  </>;
}
