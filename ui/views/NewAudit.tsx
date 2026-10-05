'use client';
import { useEffect, useState } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Field, fmt } from '../kit';
import { AGENTS, AGENT_LABEL, type AgentName, type Fault } from '../../lib/engine/types';

export function NewAudit() {
  const { api, go, meta, say, bump } = useApp();
  const { data: ds, error } = useLoad(() => api.datasets(), []);
  const ready = (ds ?? []).filter(d => d.status === 'ready');
  const [datasetId, setDatasetId] = useState('');
  const [mode, setMode] = useState<'pick' | 'pattern'>('pick');
  const [picked, setPicked] = useState<string[]>(['ALT-ALERT']);
  const [pattern, setPattern] = useState('BARO-*');
  const [layer2, setLayer2] = useState<'auto' | 'llm' | 'heuristic'>('auto');
  const [faults, setFaults] = useState<Partial<Record<AgentName, Fault>>>({});
  const { busy, run } = useAction();
  useEffect(() => { if (!datasetId && ready[0]) setDatasetId(ready[0].id); }, [ready, datasetId]);
  if (error) return <ErrorBox error={error} />;
  if (!ds) return <Loading />;
  const d = ready.find(x => x.id === datasetId);
  const modules = mode === 'pick' ? picked : pattern.split(',').map(s => s.trim()).filter(Boolean);
  const start = async () => {
    const r = await run('start', () => api.startAudits({ datasetId, modules, layer2, faults }));
    if (r) { say(`${r.runIds.length} audit${r.runIds.length > 1 ? 's' : ''} queued. Workers pick them up in a second or two.`); bump(); go(r.runIds.length === 1 ? r.runIds[0] : 'runs'); }
  };
  return <>
    <Head title="Run an audit">Five agents check each module across the whole dataset. Results go to the approval inbox, where the matching policy decides who signs.</Head>
    {!ready.length ? <div className="empty">No dataset is ready. Add one under Evidence datasets.</div> :
    <div className="grid2">
      <div className="panel">
        <Field label="Dataset" id="ds"><select id="ds" value={datasetId} onChange={e => setDatasetId(e.target.value)}>{ready.map(x => <option key={x.id} value={x.id}>{x.name} · {fmt(x.total)} records</option>)}</select></Field>
        <div className="field"><span className="lbl">Modules</span>
          <div className="seg" role="group" aria-label="How to choose modules"><button aria-pressed={mode === 'pick'} onClick={() => setMode('pick')}>Pick from list</button><button aria-pressed={mode === 'pattern'} onClick={() => setMode('pattern')}>Pattern</button></div>
          {mode === 'pick' && d && <select multiple size={8} aria-label="Modules" value={picked} onChange={e => setPicked([...e.target.selectedOptions].map(o => o.value))}>{d.modules.map(m => <option key={m.id} value={m.id}>{m.id} · {m.name} · DAL {m.dal}</option>)}</select>}
          {mode === 'pattern' && <input aria-label="Module pattern" value={pattern} onChange={e => setPattern(e.target.value)} placeholder="BARO-*, ALT-ALERT or *" />}
          <small className="dim">{mode === 'pick' ? 'Ctrl or Cmd to pick several.' : 'Comma-separated. * matches anything; * alone means every module.'}</small></div>
        <div className="field"><span className="lbl">Layer 2 reader</span>
          <div className="seg" role="group" aria-label="Layer 2">{(['auto', 'llm', 'heuristic'] as const).map(k => <button key={k} aria-pressed={layer2 === k} disabled={k === 'llm' && !meta.llm.configured} onClick={() => setLayer2(k)}>{k === 'auto' ? 'Auto' : k === 'llm' ? `LLM (${meta.llm.configured ? meta.llm.model : 'not configured'})` : 'Rule-based'}</button>)}</div></div>
        <details><summary>Fault injection, to demonstrate resilience</summary>
          <div className="faults">{AGENTS.map(a => <div className="field" key={a}><label htmlFor={`f-${a}`}>{AGENT_LABEL[a]}</label>
            <select id={`f-${a}`} value={faults[a] ?? 'none'} onChange={e => setFaults(f => ({ ...f, [a]: e.target.value as Fault }))}>
              <option value="none">Normal</option><option value="flaky">Flaky (fails twice)</option><option value="offline">Offline</option><option value="malformed">Sends bad messages</option></select></div>)}</div></details>
        <div className="row"><button className="btn primary" disabled={busy === 'start' || !modules.length} onClick={start}>{busy === 'start' ? 'Queuing…' : `Audit ${modules.length === 1 && !modules[0].includes('*') ? modules[0] : 'selected modules'}`}</button></div>
      </div>
      <div className="panel"><h2>What happens next</h2>
        <ol className="plain">
          <li>Each module becomes a job on the queue. Any free worker takes it.</li>
          <li>Layer 1 rules and Layer 2 semantic review run; every Layer 2 claim is checked against the source.</li>
          <li>The orchestrator sets the verdict, then the highest-priority matching approval policy is frozen onto the run.</li>
          <li>The people that policy names see it in their inbox and sign it with one click.</li>
        </ol>
      </div>
    </div>}
  </>;
}
