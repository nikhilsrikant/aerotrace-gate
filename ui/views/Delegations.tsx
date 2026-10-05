'use client';
import { useState } from 'react';
import { useApp, useLoad, useAction, Head, Empty, Loading, ErrorBox, Field, when } from '../kit';

export function Delegations() {
  const { api, me, dir, can } = useApp();
  const { data, error, reload } = useLoad(() => api.delegations(), []);
  const { busy, run } = useAction();
  const today = new Date(); const inWeek = new Date(Date.now() + 7 * 86400e3);
  const d10 = (d: Date) => d.toISOString().slice(0, 10);
  const [f, setF] = useState({ fromUserId: me.user.id, toUserId: '', startsAt: d10(today), endsAt: d10(inWeek), reason: '' });
  const name = (id: string) => dir.users.find(u => u.id === id)?.name ?? id;
  const now = Date.now();
  return <>
    <Head title="Delegations">Hand your approval authority to a colleague for set dates, for leave or travel. They sign on your behalf, and every signature records that. Delegates can't pass it on again.</Head>
    <form className="panel" onSubmit={async e => { e.preventDefault(); await run('add', async () => { await api.createDelegation({ ...f, startsAt: new Date(f.startsAt + 'T00:00:00').toISOString(), endsAt: new Date(f.endsAt + 'T23:59:59').toISOString() }); setF({ ...f, reason: '', toUserId: '' }); await reload(); }, 'Delegation saved.'); }}>
      <div className="row">
        {can('delegation.manage') ? <Field label="From" id="d-from"><select id="d-from" value={f.fromUserId} onChange={e => setF({ ...f, fromUserId: e.target.value })}>{dir.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field> : <div className="field"><span className="lbl">From</span><span>{me.user.name}</span></div>}
        <Field label="To" id="d-to"><select id="d-to" value={f.toUserId} onChange={e => setF({ ...f, toUserId: e.target.value })} required><option value="">Pick a colleague</option>{dir.users.filter(u => u.id !== f.fromUserId).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="From date" id="d-s"><input id="d-s" type="date" value={f.startsAt} onChange={e => setF({ ...f, startsAt: e.target.value })} /></Field>
        <Field label="Until (inclusive)" id="d-e"><input id="d-e" type="date" value={f.endsAt} onChange={e => setF({ ...f, endsAt: e.target.value })} /></Field>
        <Field label="Reason" id="d-r"><input id="d-r" value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="Annual leave" required /></Field>
        <button className="btn primary" disabled={busy === 'add'} type="submit">Delegate</button>
      </div>
      <small className="dim">At most 90 days. Covers every step the delegating person could sign.</small>
    </form>
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> : !data.length ? <Empty title="No delegations." /> :
      <div className="tbl"><table><thead><tr><th>From</th><th>To</th><th>Window</th><th>Reason</th><th>State</th><th /></tr></thead><tbody>
        {data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(d => { const active = !d.revokedAt && Date.parse(d.startsAt) <= now && now < Date.parse(d.endsAt);
          return <tr key={d.id}><td>{name(d.fromUserId)}</td><td>{name(d.toUserId)}</td><td className="sm">{when(d.startsAt)} to {when(d.endsAt)}</td><td>{d.reason}</td>
            <td>{d.revokedAt ? <span className="pill">Revoked</span> : active ? <span className="pill ok">Active</span> : Date.parse(d.endsAt) <= now ? <span className="pill">Ended</span> : <span className="pill acc">Upcoming</span>}</td>
            <td>{!d.revokedAt && Date.parse(d.endsAt) > now && (d.fromUserId === me.user.id || can('delegation.manage')) && <button className="btn ghost sm" onClick={() => run('r' + d.id, async () => { await api.revokeDelegation(d.id); await reload(); }, 'Delegation revoked.')}>Revoke</button>}</td></tr>; })}
      </tbody></table></div>}
  </>;
}
