'use client';
import { useState } from 'react';
import { useApp, useLoad, useAction, Empty, Loading, ErrorBox, Field, Drawer, Confirm, when } from '../kit';
import type { SourceInput, SourceTest } from '../api';
import type { EvidenceSource } from '../../lib/core/model';

const blank = (): SourceInput => ({ name: '', git: { provider: 'github', repo: '', ref: 'main', root: '', baselineRef: '', tokenRef: '' }, jira: null, ci: null, autoAudit: null });

/** Evidence sources: Git + Jira + CI, synced into dataset versions. Shown on the Evidence datasets page. */
export function Sources({ onSynced }: { onSynced: () => void }) {
  const { api, can, tick } = useApp();
  const { data, error, reload } = useLoad(() => api.sources(), [tick], 5000);
  const [edit, setEdit] = useState<SourceInput | null>(null);
  const [test, setTest] = useState<{ id: string; r: SourceTest } | null>(null);
  const { busy, run } = useAction();
  const manage = can('dataset.manage');
  return <section className="panel">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <div><h3 style={{ margin: 0 }}>Evidence sources</h3>
        <small className="dim">Pull evidence from where it lives: the repository at a branch or tag, problem reports from a Jira query, test results and coverage from CI. Each sync that finds new inputs records a new dataset version with its commit and provenance.</small></div>
      {manage && <button className="btn" onClick={() => setEdit(blank())}>Add source</button>}
    </div>
    {api.mode === 'browser' && <small className="dim">The browser demo cannot reach Git, Jira or CI. You can set a source up here; syncing needs the deployed app.</small>}
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> : !data.length ? <Empty title="No sources yet.">{manage && <span>Point one at the repository that holds bundle.json.</span>}</Empty> :
      <div className="tbl"><table><thead><tr><th>Source</th><th>Pulls from</th><th>Last sync</th><th /></tr></thead><tbody>
        {data.map((s: EvidenceSource) => <tr key={s.id}>
          <td><b style={{ fontWeight: 600 }}>{s.name}</b>{s.autoAudit && <div className="dim sm">Audits {s.autoAudit.modules.join(', ')} after new evidence</div>}</td>
          <td className="sm"><div className="mono">{s.git.provider} {s.git.repo}@{s.git.ref}{s.git.root ? ` /${s.git.root}` : ''}</div>
            {s.git.baselineRef && <div className="dim">Baseline from {s.git.baselineRef}</div>}
            {s.jira && <div className="dim">Jira: {s.jira.jql.slice(0, 60)}</div>}
            {s.ci && <div className="dim">CI: {s.ci.kind === 'github-actions' ? `Actions ${s.ci.workflow ?? ''} artifact ${s.ci.artifact ?? 'aerotrace-evidence'}` : s.ci.kind === 'gitlab' ? `GitLab job ${s.ci.job}` : 'URLs'}</div>}</td>
          <td className="sm">{!s.lastSync ? <span className="dim">Never</span> : <>
            {s.lastSync.status === 'failed' ? <span className="pill bad">Failed</span> : s.lastSync.status === 'unchanged' ? <span className="pill">No change</span> : <span className="pill ok">New version</span>}
            <span className="dim"> {when(s.lastSync.at)}</span>{s.lastSync.commit && <div className="mono dim">{s.lastSync.commit.slice(0, 12)}</div>}
            {s.lastSync.error && <div className="err-text">{s.lastSync.error}</div>}</>}
            {test?.id === s.id && <div className="sm" style={{ marginTop: 6 }}>{test.r.ok ? <>Dry run: {test.r.program} at <span className="mono">{test.r.commit.slice(0, 12)}</span>, {test.r.modules.length} modules, {test.r.total.toLocaleString()} records{test.r.unchanged ? ', same as the last sync' : ''}.
              {test.r.warnings.length > 0 && <details><summary>{test.r.warnings.length} warnings</summary><ul>{test.r.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}</> : <span className="err-text">Dry run failed: {test.r.error}</span>}</div>}
          </td>
          <td>{manage && <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <button className="btn primary sm" disabled={busy === 's' + s.id} onClick={() => run('s' + s.id, async () => { const r = await api.syncSource(s.id); await reload(); onSynced(); return r; }, 'Sync started.')}>Sync now</button>
            <button className="btn sm" disabled={busy === 't' + s.id} onClick={() => run('t' + s.id, async () => setTest({ id: s.id, r: await api.testSource(s.id) }))}>Dry run</button>
            <button className="btn sm" onClick={() => setEdit({ ...s })}>Edit</button>
            <Confirm text="Remove this source? Its dataset versions stay." danger onYes={() => run('d' + s.id, async () => { await api.deleteSource(s.id); await reload(); }, 'Source removed.')}><button className="btn ghost sm">Remove</button></Confirm>
          </div>}</td>
        </tr>)}</tbody></table></div>}
    {edit && <SourceEditor value={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reload(); }} />}
  </section>;
}

function SourceEditor({ value, onClose, onSaved }: { value: SourceInput; onClose: () => void; onSaved: () => void }) {
  const { api } = useApp(); const { busy, run } = useAction();
  const [s, setS] = useState<SourceInput>(value);
  const [junit, setJunit] = useState((value.ci?.junitUrls ?? []).join('\n'));
  const [auto, setAuto] = useState((value.autoAudit?.modules ?? []).join(', '));
  const g = s.git; const setG = (p: Partial<SourceInput['git']>) => setS({ ...s, git: { ...g, ...p } });
  const j = s.jira; const setJ = (p: Partial<NonNullable<SourceInput['jira']>>) => setS({ ...s, jira: { ...j!, ...p } });
  const c = s.ci; const setC = (p: Partial<NonNullable<SourceInput['ci']>>) => setS({ ...s, ci: { ...c!, ...p } });
  const save = () => run('save', async () => {
    const mods = auto.split(',').map(x => x.trim()).filter(Boolean);
    await api.saveSource({ ...s, ci: c ? { ...c, junitUrls: junit.split(/\s+/).filter(Boolean) } : null, autoAudit: mods.length ? { modules: mods, layer2: 'auto' } : null }); onSaved();
  }, 'Source saved.');
  return <Drawer title={value.id ? 'Edit evidence source' : 'New evidence source'} onClose={onClose}
    footer={<><button className="btn primary" disabled={busy === 'save'} onClick={save}>Save source</button><button className="btn" onClick={onClose}>Cancel</button></>}>
    <Field label="Name" id="src-name"><input id="src-name" value={s.name} onChange={e => setS({ ...s, name: e.target.value })} placeholder="FCC-2 main" /></Field>
    <h4 style={{ margin: '8px 0 0' }}>Repository</h4>
    <div className="seg" role="group" aria-label="Git host">{(['github', 'gitlab'] as const).map(p => <button key={p} aria-pressed={g.provider === p} onClick={() => setG({ provider: p })}>{p === 'github' ? 'GitHub' : 'GitLab'}</button>)}</div>
    <Field label="Server" id="src-base" hint="Leave empty for github.com or gitlab.com. For GitHub Enterprise Server or self-managed GitLab, the https address."><input id="src-base" value={g.baseUrl ?? ''} onChange={e => setG({ baseUrl: e.target.value })} placeholder="https://github.example.com" /></Field>
    <Field label="Repository" id="src-repo"><input id="src-repo" className="mono" value={g.repo} onChange={e => setG({ repo: e.target.value })} placeholder={g.provider === 'github' ? 'acme/fcc-evidence' : 'acme/flight/fcc'} /></Field>
    <div className="row"><Field label="Branch, tag or commit" id="src-ref"><input id="src-ref" className="mono" value={g.ref} onChange={e => setG({ ref: e.target.value })} /></Field>
      <Field label="Bundle folder" id="src-root" hint="Where bundle.json sits. Empty for the top."><input id="src-root" className="mono" value={g.root ?? ''} onChange={e => setG({ root: e.target.value })} placeholder="evidence" /></Field></div>
    <Field label="Baseline tag" id="src-bl" hint="Optional. The checksum list is computed from this tag, so any source file changed since it shows up as baseline drift. Without it, cm/baseline.csv from the repository is used."><input id="src-bl" className="mono" value={g.baselineRef ?? ''} onChange={e => setG({ baselineRef: e.target.value })} placeholder="baseline/B-2026.1" /></Field>
    <Field label="Token (secret reference)" id="src-tok" hint="A reference such as aws-sm://aerotrace/connectors/github or env://CONNECTOR_GITHUB_TOKEN. The token itself is never stored here."><input id="src-tok" className="mono" value={g.tokenRef ?? ''} onChange={e => setG({ tokenRef: e.target.value })} /></Field>

    <label className="check"><input type="checkbox" checked={!!j} onChange={e => setS({ ...s, jira: e.target.checked ? { baseUrl: '', deployment: 'cloud', jql: 'project = FCC AND issuetype = "Problem Report"', auth: 'basic', email: '', tokenRef: '' } : null })} />Problem reports from Jira</label>
    {j && <>
      <div className="seg" role="group" aria-label="Jira deployment">{(['cloud', 'server'] as const).map(d => <button key={d} aria-pressed={j.deployment === d} onClick={() => setJ({ deployment: d, auth: d === 'cloud' ? 'basic' : 'bearer' })}>{d === 'cloud' ? 'Jira Cloud' : 'Server / Data Center'}</button>)}</div>
      <Field label="Site" id="j-base"><input id="j-base" value={j.baseUrl} onChange={e => setJ({ baseUrl: e.target.value })} placeholder="https://acme.atlassian.net" /></Field>
      <Field label="JQL" id="j-jql"><textarea id="j-jql" className="mono" rows={2} value={j.jql} onChange={e => setJ({ jql: e.target.value })} /></Field>
      {j.auth === 'basic' && <Field label="Account email" id="j-email"><input id="j-email" value={j.email ?? ''} onChange={e => setJ({ email: e.target.value })} /></Field>}
      <Field label={j.auth === 'basic' ? 'API token (secret reference)' : 'Personal access token (secret reference)'} id="j-tok"><input id="j-tok" className="mono" value={j.tokenRef} onChange={e => setJ({ tokenRef: e.target.value })} /></Field>
      <div className="row"><Field label="Module from" id="j-mod" hint="components, labels (module:ID), or a custom field id"><input id="j-mod" className="mono" value={j.moduleField ?? ''} onChange={e => setJ({ moduleField: e.target.value })} placeholder="components" /></Field>
        <Field label="Files field" id="j-files" hint="Optional custom field id; file:path labels also work"><input id="j-files" className="mono" value={j.filesField ?? ''} onChange={e => setJ({ filesField: e.target.value })} placeholder="customfield_10042" /></Field></div>
    </>}

    <label className="check"><input type="checkbox" checked={!!c} onChange={e => setS({ ...s, ci: e.target.checked ? { kind: g.provider === 'github' ? 'github-actions' : 'gitlab' } : null })} />Test results and coverage from CI</label>
    {c && <>
      <div className="seg" role="group" aria-label="CI">{(['github-actions', 'gitlab', 'urls'] as const).map(k => <button key={k} aria-pressed={c.kind === k} onClick={() => setC({ kind: k })}>{k === 'github-actions' ? 'GitHub Actions' : k === 'gitlab' ? 'GitLab job' : 'Links'}</button>)}</div>
      {c.kind === 'github-actions' && <div className="row"><Field label="Workflow file" id="c-wf" hint="Optional"><input id="c-wf" className="mono" value={c.workflow ?? ''} onChange={e => setC({ workflow: e.target.value })} placeholder="evidence.yml" /></Field>
        <Field label="Artifact" id="c-art"><input id="c-art" className="mono" value={c.artifact ?? ''} onChange={e => setC({ artifact: e.target.value })} placeholder="aerotrace-evidence" /></Field></div>}
      {c.kind === 'gitlab' && <Field label="Job name" id="c-job"><input id="c-job" className="mono" value={c.job ?? ''} onChange={e => setC({ job: e.target.value })} placeholder="evidence" /></Field>}
      {c.kind === 'urls' && <><Field label="JUnit XML links" id="c-ju" hint="One per line"><textarea id="c-ju" className="mono" rows={3} value={junit} onChange={e => setJunit(e.target.value)} /></Field>
        <Field label="Coverage link" id="c-cov" hint="coverage.csv or lcov.info"><input id="c-cov" className="mono" value={c.coverageUrl ?? ''} onChange={e => setC({ coverageUrl: e.target.value })} /></Field></>}
      <Field label="CI token (secret reference)" id="c-tok" hint="Optional. Defaults to the repository token for Actions and GitLab."><input id="c-tok" className="mono" value={c.tokenRef ?? ''} onChange={e => setC({ tokenRef: e.target.value })} /></Field>
    </>}
    <Field label="Audit after new evidence" id="src-auto" hint="Optional module IDs or patterns, comma-separated. Runs only when a sync records a new version."><input id="src-auto" value={auto} onChange={e => setAuto(e.target.value)} placeholder="AP-*, YAW-DAMP" /></Field>
  </Drawer>;
}
