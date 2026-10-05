'use client';
// Platform administrators: create and rename workspaces. Each workspace is a program (or customer) with its own
// datasets, audits, policies, groups, schedules, tokens and settings. People are added from inside each workspace.
import { useState } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Field, when } from '../kit';

export function WorkspacesView() {
  const { api, meta, bump } = useApp();
  const { data, error, reload } = useLoad(() => api.workspaces(), []);
  const [name, setName] = useState(''); const [edit, setEdit] = useState<{ id: string; name: string } | null>(null);
  const { busy, run } = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return <>
    <Head title="Workspaces">One workspace per program or customer. Data, approval policies, groups, schedules, API tokens and notification settings never cross between them. People are shared: add someone to a workspace from its Users page and give them roles there. The passkey policy applies to every workspace.</Head>
    {data.platformAdmin && <div className="panel">
      <h2>New workspace</h2>
      <form className="row" onSubmit={e => { e.preventDefault(); run('new', async () => { await api.createWorkspace(name); setName(''); await reload(); bump(); }, `Workspace "${name}" created. You administer it; it has a Reviewers group and a one-reviewer policy to start from.`); }}>
        <Field label="Name" id="ws-n"><input id="ws-n" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. FCC-2 Flight Controls" /></Field>
        <button className="btn primary" disabled={!name.trim() || busy === 'new'}>Create</button>
      </form>
    </div>}
    <div className="tbl"><table><thead><tr><th>Workspace</th><th>Slug</th><th>Created</th><th /></tr></thead><tbody>
      {data.workspaces.map(w => <tr key={w.id}>
        <td>{edit?.id === w.id
          ? <form className="row" onSubmit={e => { e.preventDefault(); run('r' + w.id, async () => { await api.renameWorkspace(w.id, edit.name); setEdit(null); await reload(); bump(); }, 'Renamed.'); }}><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} autoFocus /><button className="btn sm primary">Save</button></form>
          : <><b style={{ fontWeight: 600 }}>{w.name}</b>{w.id === meta.workspace?.id && <span className="pill acc" style={{ marginLeft: 6 }}>current</span>}</>}</td>
        <td className="mono sm">{w.slug}</td><td className="sm">{when(w.createdAt)}</td>
        <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          {w.id !== meta.workspace?.id && <button className="btn sm" onClick={() => run('s' + w.id, async () => { await api.switchWorkspace(w.id); location.hash = 'approvals'; location.reload(); })}>Open</button>}
          {data.platformAdmin && <button className="btn sm ghost" onClick={() => setEdit({ id: w.id, name: w.name })}>Rename</button>}
        </div></td>
      </tr>)}
    </tbody></table></div>
  </>;
}
