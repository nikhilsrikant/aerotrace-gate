'use client';
// "You keep running this by hand" banner: one click turns a repeated manual audit into a schedule.
import { useApp, useLoad, useAction } from '../kit';
import { describeRecurrence } from '../../lib/core/schedule';

export function AutomationSuggestions({ compact }: { compact?: boolean }) {
  const { api, can, tick, bump } = useApp();
  const { data, reload } = useLoad(() => api.suggestions(), [tick]);
  const { busy, run } = useAction();
  if (!can('schedule.manage') || !data?.length) return null;
  return <div className="suggest" role="region" aria-label="Automation suggestions">
    {data.slice(0, compact ? 2 : 6).map(s => <div key={s.key} className="suggest-row">
      <span className="pill acc">Repeated by hand</span>
      <span className="grow"><b>{s.module}</b> on {s.datasetName}: {s.description}. Automate it {describeRecurrence(s.recurrence, s.timezone).replace(/^./, c => c.toLowerCase())}?</span>
      <button className="btn primary sm" disabled={busy === s.key} onClick={() => run(s.key, async () => {
        await api.saveSchedule({ name: `${s.module} · ${describeRecurrence(s.recurrence, s.timezone).replace(/ \(.*\)$/, '')}`, datasetId: s.datasetId, modules: [s.module], layer2: 'auto', recurrence: s.recurrence, timezone: s.timezone, enabled: true, skipIfPending: true, notifyOn: ['NO', 'failed'] });
        await reload(); bump();
      }, `${s.module} now runs by itself. Find it under Schedules.`)}>Automate</button>
      <button className="btn ghost sm" onClick={() => run('x' + s.key, async () => { await api.dismissSuggestion(s.key); await reload(); })}>Not now</button>
    </div>)}
  </div>;
}
