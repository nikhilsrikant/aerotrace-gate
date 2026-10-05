'use client';
import { useState } from 'react';
import { useApp, useLoad, useAction, Head, Empty, Loading, ErrorBox, Field, Checks, Drawer, Confirm, when, until } from '../kit';
import { AutomationSuggestions } from './Suggestions';
import type { ScheduleInput, ScheduleView } from '../api';
import type { Recurrence } from '../../lib/core/model';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES = ['UTC', 'America/Phoenix', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Prague', 'Asia/Kolkata', 'Asia/Shanghai'];
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

export function Schedules() {
  const { api, can, go, tick } = useApp();
  const { data, error, reload } = useLoad(() => api.schedules(), [tick], 5000);
  const { data: ds } = useLoad(() => api.datasets(), []);
  const { data: srcs } = useLoad(() => api.sources(), []);
  const [edit, setEdit] = useState<ScheduleInput | null>(null);
  const { busy, run } = useAction();
  const manage = can('schedule.manage');
  const blank = (): ScheduleInput => ({ name: '', datasetId: ds?.find(d => d.status === 'ready')?.id ?? '', modules: ['*'], layer2: 'auto', recurrence: { kind: 'interval', everyMinutes: 1440 }, timezone: localTz(), enabled: true, skipIfPending: true, notifyOn: ['NO', 'failed'] });
  return <>
    <Head title="Schedules" actions={manage ? <button className="btn primary" onClick={() => setEdit(blank())}>New schedule</button> : undefined}>
      Audits that run by themselves. Workers check for due schedules every 30 seconds; a schedule missed while the system was down runs once when it comes back, not once per missed slot.
    </Head>
    <AutomationSuggestions />
    {error ? <ErrorBox error={error} /> : !data ? <Loading /> : !data.length ? <Empty title="No schedules yet.">{manage && <span>Create one to audit modules every day, every few hours, or on a cron expression.</span>}</Empty> :
      <div className="inbox">{data.map((s: ScheduleView) => <article key={s.id} className="card">
        <div className={`stripe ${s.enabled ? 'on' : ''}`} />
        <div className="body">
          <div className="title"><b className="plain">{s.name}</b>{s.enabled ? <span className="pill ok">Active</span> : <span className="pill">Paused</span>}</div>
          <div className="dim2">{s.description} · modules {s.modules.join(', ')} · {s.sourceId ? `syncs ${srcs?.find(x => x.id === s.sourceId)?.name ?? 'a source'} first` : ds?.find(d => d.id === s.datasetId)?.name ?? 'dataset removed'}</div>
          <div className="meta"><span>Next: {s.enabled ? `${when(s.nextRunAt)} (${until(s.nextRunAt)})` : 'paused'}</span><span>Last: {when(s.lastRunAt)}{s.lastRunIds?.length ? ` · ${s.lastRunIds.length} audits` : ''}</span><span>Owner {s.ownerName}</span>
            <span>{s.skipIfPending ? 'Skips modules still awaiting approval' : 'Always runs'}</span><span>Alerts on {s.notifyOn.join(', ') || 'nothing'}</span></div>
          {s.lastError && <div className="err-text sm">Last attempt: {s.lastError}</div>}
          {!!s.lastRunIds?.length && <div className="row" style={{ gap: 6 }}>{s.lastRunIds.slice(0, 8).map(id => <button key={id} className="btn sm" onClick={() => go(id)}>{id.slice(4, 10)}</button>)}</div>}
        </div>
        {manage && <div className="act tight">
          <button className="btn primary" disabled={busy === s.id} onClick={() => run(s.id, async () => { const r = await api.runSchedule(s.id); await reload(); return r; }, 'Queued now. Next scheduled time is unchanged.')}>Run now</button>
          <button className="btn" onClick={() => run('t' + s.id, async () => { await api.saveSchedule({ ...s, enabled: !s.enabled }); await reload(); }, s.enabled ? 'Paused.' : 'Resumed.')}>{s.enabled ? 'Pause' : 'Resume'}</button>
          <button className="btn" onClick={() => setEdit({ ...s })}>Edit</button>
          <Confirm text="Delete this schedule?" danger onYes={() => run('d' + s.id, async () => { await api.deleteSchedule(s.id); await reload(); }, 'Schedule deleted.')}><button className="btn ghost">Delete</button></Confirm>
        </div>}
      </article>)}</div>}
    {edit && <ScheduleEditor value={edit} datasets={(ds ?? []).filter(d => d.status === 'ready')} sources={srcs ?? []} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await reload(); }} />}
  </>;
}

export function ScheduleEditor({ value, datasets, sources = [], onClose, onSaved }: { value: ScheduleInput; datasets: { id: string; name: string }[]; sources?: { id: string; name: string }[]; onClose: () => void; onSaved: () => void }) {
  const { api } = useApp(); const { busy, run } = useAction();
  const [s, setS] = useState<ScheduleInput>(value);
  const [modText, setModText] = useState(value.modules.join(', '));
  const r = s.recurrence;
  const setR = (x: Recurrence) => setS({ ...s, recurrence: x });
  const kind = r.kind === 'interval' ? (r.everyMinutes === 1440 ? 'day' : 'hours') : r.kind;
  return <Drawer title={value.id ? 'Edit schedule' : 'New schedule'} onClose={onClose}
    footer={<><button className="btn primary" disabled={busy === 'save'} onClick={() => run('save', async () => { await api.saveSchedule({ ...s, modules: modText.split(',').map(x => x.trim()).filter(Boolean) }); onSaved(); }, 'Schedule saved.')}>Save schedule</button><button className="btn" onClick={onClose}>Cancel</button></>}>
    <Field label="Name" id="s-name"><input id="s-name" value={s.name} onChange={e => setS({ ...s, name: e.target.value })} placeholder="Nightly DAL A sweep" /></Field>
    {sources.length > 0 && <div className="seg" role="group" aria-label="Evidence"><button aria-pressed={!s.sourceId} onClick={() => setS({ ...s, sourceId: null })}>A fixed dataset</button><button aria-pressed={!!s.sourceId} onClick={() => setS({ ...s, sourceId: sources[0].id })}>Sync a source first</button></div>}
    {s.sourceId ? <Field label="Evidence source" id="s-src" hint="Each run pulls the latest evidence, records a version if anything changed, then audits it."><select id="s-src" value={s.sourceId} onChange={e => setS({ ...s, sourceId: e.target.value })}>{sources.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      : <Field label="Dataset" id="s-ds"><select id="s-ds" value={s.datasetId} onChange={e => setS({ ...s, datasetId: e.target.value })}>{datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
    <Field label="Modules" id="s-mod" hint="Comma-separated IDs or patterns. * alone means every module."><input id="s-mod" value={modText} onChange={e => setModText(e.target.value)} /></Field>
    <div className="field"><span className="lbl">How often</span>
      <div className="seg" role="group" aria-label="Recurrence">
        <button aria-pressed={kind === 'day'} onClick={() => setR({ kind: 'interval', everyMinutes: 1440 })}>Every 24 hours</button>
        <button aria-pressed={kind === 'hours'} onClick={() => setR({ kind: 'interval', everyMinutes: 360 })}>Every N hours</button>
        <button aria-pressed={kind === 'daily'} onClick={() => setR({ kind: 'daily', time: '02:00' })}>Daily at</button>
        <button aria-pressed={kind === 'weekly'} onClick={() => setR({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '06:00' })}>Weekly</button>
        <button aria-pressed={kind === 'cron'} onClick={() => setR({ kind: 'cron', expr: '0 2 * * *' })}>Cron</button>
      </div>
      {r.kind === 'interval' && kind === 'hours' && <div className="row"><label htmlFor="s-h">Every</label><input id="s-h" type="number" min={1} max={744} style={{ width: 90 }} value={Math.round(r.everyMinutes / 60)} onChange={e => setR({ kind: 'interval', everyMinutes: Math.max(1, Number(e.target.value)) * 60 })} /><span>hours</span></div>}
      {(r.kind === 'daily' || r.kind === 'weekly') && <div className="row"><label htmlFor="s-t">At</label><input id="s-t" type="time" value={r.time} onChange={e => setR({ ...r, time: e.target.value })} /></div>}
      {r.kind === 'weekly' && <div className="row" style={{ gap: 4 }}>{DAYS.map((d, i) => <label key={d} className="check"><input type="checkbox" checked={r.days.includes(i)} onChange={e => setR({ ...r, days: e.target.checked ? [...r.days, i] : r.days.filter(x => x !== i) })} />{d}</label>)}</div>}
      {r.kind === 'cron' && <input aria-label="Cron expression" className="mono" value={r.expr} onChange={e => setR({ kind: 'cron', expr: e.target.value })} />}
      {r.kind === 'cron' && <small className="dim">minute hour day-of-month month day-of-week, for example 30 1 * * 1-5 for 01:30 on weekdays.</small>}
    </div>
    <Field label="Time zone" id="s-tz" hint="Daily, weekly and cron times are in this zone, daylight saving included."><input id="s-tz" list="tzs" value={s.timezone} onChange={e => setS({ ...s, timezone: e.target.value })} /><datalist id="tzs">{ZONES.map(z => <option key={z} value={z} />)}</datalist></Field>
    <label className="check"><input type="checkbox" checked={s.skipIfPending} onChange={e => setS({ ...s, skipIfPending: e.target.checked })} />Skip a module while its previous scheduled audit is still waiting for approval</label>
    <label className="check"><input type="checkbox" checked={s.enabled} onChange={e => setS({ ...s, enabled: e.target.checked })} />Active</label>
    <Checks label="Send an alert when a scheduled audit comes back" value={s.notifyOn} onChange={v => setS({ ...s, notifyOn: v })} options={[{ id: 'NO', label: 'NO' }, { id: 'CONDITIONAL', label: 'CONDITIONAL' }, { id: 'YES', label: 'YES' }, { id: 'failed', label: 'Failed to run' }]} />
    <small className="dim">The schedule runs as you. Your own audits still need someone else's approval unless a policy allows self-approval.</small>
  </Drawer>;
}
