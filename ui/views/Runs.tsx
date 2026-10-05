'use client';
import { useState } from 'react';
import { useApp, useLoad, Verdict, Status, Head, Empty, Loading, ErrorBox, when } from '../kit';
import { Trigger } from './parts';

const FILTERS: [string, string, string[] | undefined][] = [['all', 'All', undefined], ['pending', 'Awaiting approval', ['awaiting_approval']], ['active', 'Queued or running', ['queued', 'running']], ['done', 'Decided', ['approved', 'denied']], ['failed', 'Failed', ['failed']]];
export function Runs() {
  const { api, go, tick } = useApp();
  const [f, setF] = useState('all');
  const { data, error } = useLoad(() => api.runs(FILTERS.find(x => x[0] === f)![2]), [f, tick], 4000);
  return <>
    <Head title="All audits">Every run is kept with its findings, agent message trail, policy snapshot and signed decisions.</Head>
    <div className="seg" role="group" aria-label="Filter">{FILTERS.map(([k, l]) => <button key={k} aria-pressed={f === k} onClick={() => setF(k)}>{l}</button>)}</div>
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> : !data.length ? <Empty title="No audits here." /> :
      <div className="tbl"><table><thead><tr><th>Module</th><th>Dataset</th><th>Verdict</th><th>Findings S1/S2/S3</th><th>Status</th><th>Approval</th><th>Started</th></tr></thead><tbody>
        {data.map(r => <tr key={r.id} className="click" onClick={() => go(r.id)}>
          <td><span className="mono">{r.module}</span> <Trigger r={r} /><div className="dim sm">{r.moduleName} · DAL {r.dal}</div></td>
          <td className="sm">{r.datasetName}</td>
          <td><Verdict v={r.verdict} /></td>
          <td className="num">{r.summary ? `${r.summary.counts.s1} / ${r.summary.counts.s2} / ${r.summary.counts.s3}` : '–'}</td>
          <td><Status s={r.status} /></td>
          <td className="sm dim2" style={{ maxWidth: 280 }}>{r.approval.waitingOn}</td>
          <td className="num sm">{when(r.createdAt)}<div className="dim">{r.requestedByName}</div></td></tr>)}
      </tbody></table></div>}
  </>;
}
