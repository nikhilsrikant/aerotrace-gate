// Recurrence maths for scheduled audits: interval, daily, weekly and 5-field cron, evaluated in the schedule's own time zone.
import type { Recurrence } from './model';

type Field = Set<number>;
function parseField(src: string, lo: number, hi: number, name: string): Field {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step "${part}" in the ${name} field`);
    let a: number, b: number;
    if (range === '*') { a = lo; b = hi; }
    else if (range.includes('-')) { [a, b] = range.split('-').map(Number); }
    else { a = Number(range); b = stepS === undefined ? a : hi; }
    if (![a, b].every(Number.isInteger) || a < lo || b > hi || a > b) throw new Error(`"${part}" is out of range for the ${name} field (${lo}-${hi})`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
export interface Cron { min: Field; hour: Field; dom: Field; mon: Field; dow: Field; domStar: boolean; dowStar: boolean }
export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('A cron expression has 5 fields: minute hour day-of-month month day-of-week');
  const dow = parseField(f[4], 0, 7, 'day-of-week'); if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return { min: parseField(f[0], 0, 59, 'minute'), hour: parseField(f[1], 0, 23, 'hour'), dom: parseField(f[2], 1, 31, 'day-of-month'),
    mon: parseField(f[3], 1, 12, 'month'), dow, domStar: f[2] === '*', dowStar: f[4] === '*' };
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function wall(d: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }); fmtCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: WD[p.weekday] };
}
export function validTimezone(tz: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export function toCron(r: Recurrence): string | null {
  if (r.kind === 'cron') return r.expr;
  if (r.kind === 'interval') return null;
  const m = r.time.match(HHMM); if (!m) throw new Error('Time must be HH:MM in 24-hour form');
  if (r.kind === 'daily') return `${+m[2]} ${+m[1]} * * *`;
  if (!r.days.length) throw new Error('Pick at least one day of the week');
  return `${+m[2]} ${+m[1]} * * ${[...new Set(r.days)].sort().join(',')}`;
}

export function validateRecurrence(r: Recurrence, tz: string): void {
  if (!validTimezone(tz)) throw new Error(`Unknown time zone "${tz}"`);
  if (r.kind === 'interval') { if (!Number.isInteger(r.everyMinutes) || r.everyMinutes < 15 || r.everyMinutes > 60 * 24 * 31) throw new Error('Interval must be between 15 minutes and 31 days'); return; }
  parseCron(toCron(r)!);
}

/** Next fire time strictly after `after`. */
export function nextRun(r: Recurrence, tz: string, after: Date): Date {
  if (r.kind === 'interval') return new Date(after.getTime() + r.everyMinutes * 60000);
  const c = parseCron(toCron(r)!);
  let t = Math.floor(after.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < 400 * 24 * 60; i++) {
    const w = wall(new Date(t), tz);
    const dayOk = c.mon.has(w.mo) && (c.domStar && c.dowStar ? true : c.domStar ? c.dow.has(w.wd) : c.dowStar ? c.dom.has(w.d) : (c.dom.has(w.d) || c.dow.has(w.wd)));
    if (!dayOk) { t += ((23 - w.h) * 60 + (60 - w.mi)) * 60000; continue; }
    if (!c.hour.has(w.h)) { t += (60 - w.mi) * 60000; continue; }
    if (!c.min.has(w.mi)) { t += 60000; continue; }
    return new Date(t);
  }
  throw new Error('This schedule never fires');
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function describeRecurrence(r: Recurrence, tz: string): string {
  if (r.kind === 'interval') { const m = r.everyMinutes; return m % 1440 === 0 ? `Every ${m / 1440 === 1 ? 'day (24 hours)' : `${m / 1440} days`}` : m % 60 === 0 ? `Every ${m / 60} hour${m === 60 ? '' : 's'}` : `Every ${m} minutes`; }
  if (r.kind === 'daily') return `Daily at ${r.time} (${tz})`;
  if (r.kind === 'weekly') return `${[...r.days].sort().map(d => DAY[d].slice(0, 3)).join(', ')} at ${r.time} (${tz})`;
  return `Cron "${r.expr}" (${tz})`;
}
