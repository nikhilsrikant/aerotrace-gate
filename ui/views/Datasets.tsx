'use client';
import { useRef, useState } from 'react';
import { Sources } from './Sources';
import { useApp, useLoad, useAction, Head, Empty, Loading, ErrorBox, Confirm, when, fmt } from '../kit';

export function Datasets() {
  const { api, can, tick } = useApp();
  const { data, error, reload } = useLoad(() => api.datasets(), [tick], 3000);
  const { busy, run } = useAction();
  const [name, setName] = useState(''); const file = useRef<HTMLInputElement>(null);
  const manage = can('dataset.manage');
  return <>
    <Head title="Evidence datasets" actions={api.sampleUrl() ? <a className="btn" href={api.sampleUrl()!}>Download sample bundle</a> : undefined}>
      A dataset is one program baseline: requirements, design, source, test results, coverage, the baseline checksum list and problem reports, uploaded as a zip or synced from Git, Jira and CI. The sample bundle shows the exact layout.
    </Head>
    {manage && api.mode === 'server' && <form className="panel row" onSubmit={async e => { e.preventDefault(); const f = file.current?.files?.[0]; if (!f) return;
      await run('up', async () => { await api.uploadDataset(name || f.name.replace(/\.zip$/i, ''), f); setName(''); if (file.current) file.current.value = ''; await reload(); }, 'Uploaded. A worker is importing it now.'); }}>
      <div className="field grow"><label htmlFor="dn">Name</label><input id="dn" value={name} onChange={e => setName(e.target.value)} placeholder="FMS 4.2 baseline a3f9c1" /></div>
      <div className="field"><label htmlFor="df">Evidence bundle (.zip)</label><input id="df" ref={file} type="file" accept=".zip,application/zip" required /></div>
      <button className="btn primary" disabled={busy === 'up'} type="submit">{busy === 'up' ? 'Uploading…' : 'Upload'}</button>
    </form>}
    <Sources onSynced={reload} />
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> : !data.length ? <Empty title="No datasets yet." /> :
      <div className="tbl"><table><thead><tr><th>Name</th><th>Program</th><th>Source</th><th>Status</th><th>Records</th><th>Modules</th><th>Added</th><th /></tr></thead><tbody>
        {data.map(d => <tr key={d.id}>
          <td><b style={{ fontWeight: 600 }}>{d.name}</b>{d.warnings.length > 0 && <details className="sm"><summary>{d.warnings.length} import warnings</summary><ul>{d.warnings.slice(0, 30).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}</td>
          <td className="sm">{d.program}<div className="dim mono">baseline {d.baseline}</div></td>
          <td>{d.source === 'synthetic' ? <span className="pill acc">Synthetic</span> : d.provenance ? <span className="pill" title={`${d.provenance.git.repo}@${d.provenance.git.commit}${d.provenance.jira ? `, ${d.provenance.jira.issues} Jira issues` : ''}${d.provenance.ci?.run ? `, CI ${d.provenance.ci.run}` : ''}`}>Synced · <span className="mono">{d.provenance.git.commit.slice(0, 7)}</span></span> : <span className="pill">Uploaded bundle</span>}</td>
          <td>{d.status === 'ready' ? <span className="pill ok">Ready</span> : d.status === 'importing' ? <span className="pill warn"><span className="spin sm" />Importing</span> : <span className="pill bad" title={d.error ?? ''}>Failed</span>}{d.error && <div className="err-text sm">{d.error}</div>}</td>
          <td className="num">{fmt(d.total)}</td><td className="num">{d.modules.length}</td><td className="sm">{when(d.createdAt)}<div className="dim">{d.createdBy}</div></td>
          <td>{manage && <Confirm text="Remove this dataset?" danger onYes={() => run('x' + d.id, async () => { await api.deleteDataset(d.id); await reload(); }, 'Dataset removed.')}><button className="btn ghost sm">Remove</button></Confirm>}</td>
        </tr>)}</tbody></table></div>}
    {manage && <button className="btn" style={{ alignSelf: 'start' }} disabled={busy === 'syn'} onClick={() => run('syn', async () => { await api.createSynthetic(`Synthetic program ${new Date().toLocaleDateString()}`, Math.floor(Math.random() * 1e6)); await reload(); }, 'Generated a new 50,000-record synthetic program.')}>Generate another synthetic program</button>}
  </>;
}
