'use client';
import { useEffect, useState } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Field, Checks, Drawer, Confirm, when } from '../kit';
import type { PolicyInput, Simulation } from '../api';
import type { ApprovalPolicy, PolicyStep } from '../../lib/core/model';
import type { DAL, Verdict } from '../../lib/engine/types';

const DALS: DAL[] = ['A', 'B', 'C', 'D'];
const VERDICTS: Verdict[] = ['NO', 'CONDITIONAL', 'YES'];
let n = 0; const tmpId = () => `new_${Date.now()}_${n++}`;

export function Policies() {
  const { api, can, dir } = useApp();
  const { data, error, reload } = useLoad(() => api.policies(), []);
  const [edit, setEdit] = useState<PolicyInput | null>(null);
  const { run } = useAction();
  const manage = can('policy.manage');
  const gname = (id: string) => dir.groups.find(g => g.id === id)?.name ?? 'removed group';
  const uname = (id: string) => dir.users.find(u => u.id === id)?.name ?? 'removed user';
  const blank: PolicyInput = { name: '', description: '', priority: 10, active: true, match: { datasetIds: [], modules: [], dals: [], verdicts: [] },
    steps: [{ id: tmpId(), name: 'Sign-off', groupIds: [], userIds: [], min: 1 }], sequential: true, allowSelfApproval: false, denyRequiresReason: false };
  return <>
    <Head title="Approval policies" actions={manage ? <button className="btn primary" onClick={() => setEdit(blank)}>New policy</button> : undefined}>
      Policies decide who may approve or deny each audit. When an audit finishes, the highest-priority active policy that matches its dataset, module, DAL and verdict is frozen onto it. Change who signs what here, without touching code. Everyone can read this page; only people with the policy permission can edit it.
    </Head>
    <Simulator />
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> :
      <div className="inbox">{data.map(p => <article key={p.id} className="card">
        <div className={`stripe ${p.active ? 'on' : ''}`} />
        <div className="body">
          <div className="title"><b className="plain">{p.name}</b><span className="pill">priority {p.priority}</span>{p.active ? <span className="pill ok">Active</span> : <span className="pill">Off</span>}<span className="dim sm">v{p.version} · {p.updatedBy} · {when(p.updatedAt)}</span></div>
          {p.description && <div className="dim2">{p.description}</div>}
          <div className="sm"><b>Applies to:</b> {matchText(p, n => n)}</div>
          <ol className="steps">{p.steps.map((s, i) => <li key={s.id} className="step open"><span className="dot">{i + 1}</span><div><b>{s.name}</b> <span className="dim">needs {s.min}</span>
            <div className="sm dim2">{[...s.groupIds.map(g => `group ${gname(g)}`), ...s.userIds.map(u => uname(u))].join(', ')}</div></div></li>)}</ol>
          <div className="meta"><span>{p.sequential ? 'Steps in order' : 'Steps in any order'}</span><span>{p.allowSelfApproval ? 'Requester may approve' : 'Requester may not approve'}</span><span>{p.denyRequiresReason ? 'Denial needs a reason' : 'Denial reason optional'}</span></div>
        </div>
        {manage && <div className="act tight"><button className="btn" onClick={() => setEdit({ ...p })}>Edit</button>
          <Confirm text="Delete this policy?" danger onYes={() => run('d', async () => { await api.deletePolicy(p.id); await reload(); }, 'Policy deleted.')}><button className="btn ghost">Delete</button></Confirm></div>}
      </article>)}</div>}
    {edit && <PolicyEditor value={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reload(); }} />}
  </>;
}

function matchText(p: ApprovalPolicy, _f: (s: string) => string) {
  const m = p.match; const parts: string[] = [];
  parts.push(m.dals.length ? `DAL ${m.dals.join(', ')}` : 'any DAL');
  parts.push(m.verdicts.length ? `verdict ${m.verdicts.join(' or ')}` : 'any verdict');
  if (m.modules.length) parts.push(`modules ${m.modules.join(', ')}`);
  if (m.datasetIds.length) parts.push(`${m.datasetIds.length} dataset(s)`);
  return parts.join(' · ');
}

function Simulator() {
  const { api, dir } = useApp();
  const { data: ds } = useLoad(() => api.datasets(), []);
  const [datasetId, setD] = useState(''); const [module, setM] = useState('BARO-IN'); const [verdict, setV] = useState<Verdict>('NO'); const [req, setReq] = useState('');
  const [sim, setSim] = useState<Simulation | null>(null);
  const d = ds?.find(x => x.id === datasetId) ?? ds?.find(x => x.status === 'ready');
  const mod = d?.modules.find(m => m.id === module) ?? d?.modules[0];
  useEffect(() => { if (!d || !mod) return; api.simulate({ datasetId: d.id, module: mod.id, dal: mod.dal, verdict, requestedBy: req || dir.users[0]?.id || '' }).then(setSim).catch(() => setSim(null)); }, [api, d, mod, verdict, req, dir.users]);
  if (!d) return null;
  return <div className="panel sim">
    <div className="row"><h2 className="grow">Who would sign this?</h2><span className="dim sm">Try a case before you change anything</span></div>
    <div className="row">
      <select aria-label="Dataset" value={d.id} onChange={e => setD(e.target.value)}>{ds!.filter(x => x.status === 'ready').map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      <select aria-label="Module" value={mod?.id} onChange={e => setM(e.target.value)}>{d.modules.map(m => <option key={m.id} value={m.id}>{m.id} · DAL {m.dal}</option>)}</select>
      <select aria-label="Verdict" value={verdict} onChange={e => setV(e.target.value as Verdict)}>{VERDICTS.map(v => <option key={v}>{v}</option>)}</select>
      <select aria-label="Requested by" value={req} onChange={e => setReq(e.target.value)}><option value="">Requested by…</option>{dir.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
    </div>
    {sim && (sim.policy ? <div className="sm"><b>{sim.policy.name}</b> v{sim.policy.version} applies.
      <ol className="steps">{sim.steps.map((s, i) => <li key={i} className="step open"><span className="dot">{i + 1}</span><div><b>{s.name}</b> <span className="dim">needs {s.min}</span><div className="dim2">{s.eligible.length ? s.eligible.join(', ') : 'Nobody is eligible. Add people to this step.'}</div></div></li>)}</ol></div>
      : <div className="err-text sm">No policy matches. An audit like this would wait until an administrator adds one.</div>)}
  </div>;
}

function PolicyEditor({ value, onClose, onSaved }: { value: PolicyInput; onClose: () => void; onSaved: () => void }) {
  const { api, dir } = useApp(); const { busy, run } = useAction();
  const { data: ds } = useLoad(() => api.datasets(), []);
  const [p, setP] = useState<PolicyInput>(value);
  const [mods, setMods] = useState(value.match.modules.join(', '));
  const setStep = (i: number, s: Partial<PolicyStep>) => setP({ ...p, steps: p.steps.map((x, k) => (k === i ? { ...x, ...s } : x)) });
  const move = (i: number, d: number) => { const st = [...p.steps]; const [x] = st.splice(i, 1); st.splice(i + d, 0, x); setP({ ...p, steps: st }); };
  const save = () => run('save', async () => {
    await api.savePolicy({ ...p, match: { ...p.match, modules: mods.split(',').map(s => s.trim()).filter(Boolean) }, steps: p.steps.map(s => ({ ...s, id: s.id.startsWith('new_') ? '' : s.id })) });
    onSaved();
  }, 'Policy saved. New audits use it; audits already waiting keep the version they started with.');
  return <Drawer title={value.id ? `Edit ${value.name}` : 'New approval policy'} onClose={onClose}
    footer={<><button className="btn primary" disabled={busy === 'save'} onClick={save}>Save policy</button><button className="btn" onClick={onClose}>Cancel</button></>}>
    <Field label="Name" id="p-name"><input id="p-name" value={p.name} onChange={e => setP({ ...p, name: e.target.value })} placeholder="DAL A: SQA then DER" /></Field>
    <Field label="Description" id="p-desc"><input id="p-desc" value={p.description} onChange={e => setP({ ...p, description: e.target.value })} /></Field>
    <div className="row"><Field label="Priority" id="p-pri" hint="Higher wins when several match."><input id="p-pri" type="number" style={{ width: 110 }} value={p.priority} onChange={e => setP({ ...p, priority: Number(e.target.value) })} /></Field>
      <label className="check"><input type="checkbox" checked={p.active} onChange={e => setP({ ...p, active: e.target.checked })} />Active</label></div>
    <h3>Applies to</h3>
    <Checks label="DAL (none ticked = any)" options={DALS.map(d => ({ id: d, label: `DAL ${d}` }))} value={p.match.dals} onChange={v => setP({ ...p, match: { ...p.match, dals: v } })} />
    <Checks label="Verdict (none ticked = any)" options={VERDICTS.map(v => ({ id: v, label: v }))} value={p.match.verdicts} onChange={v => setP({ ...p, match: { ...p.match, verdicts: v } })} />
    <Field label="Modules (blank = any)" id="p-mod" hint="Comma-separated; * is a wildcard, for example BARO-*, FLT-*"><input id="p-mod" value={mods} onChange={e => setMods(e.target.value)} /></Field>
    <Checks label="Datasets (none ticked = any)" options={(ds ?? []).map(d => ({ id: d.id, label: d.name }))} value={p.match.datasetIds} onChange={v => setP({ ...p, match: { ...p.match, datasetIds: v } })} />
    <h3>Sign-off steps</h3>
    {p.steps.map((s, i) => <div key={s.id} className="stepedit">
      <div className="row"><span className="dot">{i + 1}</span><input aria-label="Step name" className="grow" value={s.name} onChange={e => setStep(i, { name: e.target.value })} />
        <label className="row sm">needs <input type="number" min={1} max={10} style={{ width: 64 }} value={s.min} onChange={e => setStep(i, { min: Number(e.target.value) })} /> approval{s.min > 1 ? 's' : ''}</label>
        <button className="btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button><button className="btn sm" disabled={i === p.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
        <button className="btn ghost sm" disabled={p.steps.length === 1} onClick={() => setP({ ...p, steps: p.steps.filter((_, k) => k !== i) })}>Remove</button></div>
      <Checks label="Any member of these groups" options={dir.groups.map(g => ({ id: g.id, label: g.name }))} value={s.groupIds} onChange={v => setStep(i, { groupIds: v })} />
      <div className="field"><label htmlFor={`u-${s.id}`}>Or these people</label>
        <select id={`u-${s.id}`} multiple size={Math.min(6, dir.users.length)} value={s.userIds} onChange={e => setStep(i, { userIds: [...e.target.selectedOptions].map(o => o.value) })}>{dir.users.map(u => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}</select></div>
    </div>)}
    <button className="btn" onClick={() => setP({ ...p, steps: [...p.steps, { id: tmpId(), name: `Step ${p.steps.length + 1}`, groupIds: [], userIds: [], min: 1 }] })}>Add a step</button>
    <h3>Rules</h3>
    <label className="check"><input type="checkbox" checked={p.sequential} onChange={e => setP({ ...p, sequential: e.target.checked })} />Steps must be signed in order</label>
    <label className="check"><input type="checkbox" checked={p.allowSelfApproval} onChange={e => setP({ ...p, allowSelfApproval: e.target.checked })} />Let the person who requested the audit approve it (not recommended)</label>
    <label className="check"><input type="checkbox" checked={p.denyRequiresReason} onChange={e => setP({ ...p, denyRequiresReason: e.target.checked })} />Require a reason to deny</label>
    <small className="dim">One person can never fill two steps of the same audit. Delegations let a signer's authority pass to a colleague for set dates.</small>
  </Drawer>;
}
