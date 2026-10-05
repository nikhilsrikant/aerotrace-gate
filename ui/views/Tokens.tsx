'use client';
import { useState } from 'react';
import { useApp, useLoad, useAction, Head, Empty, Loading, ErrorBox, Field, when } from '../kit';

export function Tokens() {
  const { api, dir, can, me } = useApp();
  const { data, error, reload } = useLoad(() => api.tokens(), []);
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: '', days: 90, userId: me.user.id });
  const [shown, setShown] = useState<string | null>(null);
  const name = (id: string) => dir.users.find(u => u.id === id)?.name ?? id;
  return <>
    <Head title="API tokens">For build pipelines and scripts. A token acts as the person it belongs to, with their permissions. Send it as <span className="mono">Authorization: Bearer atg_…</span>; for example <span className="mono">POST /api/runs</span> to start audits from CI.</Head>
    <form className="panel row" onSubmit={async e => { e.preventDefault(); const r = await run('new', () => api.createToken({ name: f.name, expiresInDays: f.days, userId: f.userId })); if (r) { setShown(r.token); setF({ ...f, name: '' }); await reload(); } }}>
      <Field label="What will use it" id="t-n"><input id="t-n" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Jenkins nightly" required /></Field>
      <Field label="Expires after (days)" id="t-d"><input id="t-d" type="number" min={1} max={365} style={{ width: 110 }} value={f.days} onChange={e => setF({ ...f, days: Number(e.target.value) })} /></Field>
      {can('access.manage') && <Field label="Acts as" id="t-u"><select id="t-u" value={f.userId} onChange={e => setF({ ...f, userId: e.target.value })}>{dir.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
      <button className="btn primary" disabled={busy === 'new'} type="submit">Create token</button>
    </form>
    {shown && <div className="panel tokenbox"><b>Copy this token now. It won't be shown again.</b><code className="mono">{shown}</code>
      <div className="row"><button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(shown); } catch { /* select it manually */ } }}>Copy</button><button className="btn ghost" onClick={() => setShown(null)}>Done</button></div></div>}
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> : !data.length ? <Empty title="No tokens." /> :
      <div className="tbl"><table><thead><tr><th>Name</th><th>Acts as</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead><tbody>
        {data.map(t => <tr key={t.id}><td>{t.name}</td><td>{name(t.userId)}</td><td className="mono sm">{t.prefix}…</td><td className="sm">{when(t.createdAt)}</td><td className="sm">{when(t.lastUsedAt)}</td>
          <td className="sm">{t.revokedAt ? <span className="pill">Revoked</span> : when(t.expiresAt)}</td>
          <td>{!t.revokedAt && <button className="btn ghost sm" onClick={() => run('r' + t.id, async () => { await api.revokeToken(t.id); await reload(); }, 'Token revoked.')}>Revoke</button>}</td></tr>)}
      </tbody></table></div>}
  </>;
}
