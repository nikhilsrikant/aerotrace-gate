'use client';
// Small shared pieces: data loading, toasts, badges, form controls.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Api, Me, Meta, Directory } from './api';
import type { Permission } from '../lib/core/model';

export interface AppCtx { api: Api; me: Me; meta: Meta; dir: Directory; refreshDir: () => Promise<void>; say: (t: string, err?: boolean) => void; go: (hash: string) => void; can: (p: Permission) => boolean; bump: () => void; tick: number; focus: string | null; setFocus: (id: string | null) => void }
export const Ctx = createContext<AppCtx>(null as never);
export const useApp = () => useContext(Ctx);

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number): { data: T | null; error: string | null; reload: () => Promise<void>; loading: boolean } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const live = useRef(true); const fnRef = useRef(fn); fnRef.current = fn;
  const reload = useCallback(async () => { try { const v = await fnRef.current(); if (live.current) { setData(v); setError(null); } } catch (e) { lockedIf(e); if (live.current) setError(e instanceof Error ? e.message : String(e)); } finally { if (live.current) setLoading(false); } }, []);
  useEffect(() => { live.current = true; setLoading(true); reload(); let t: ReturnType<typeof setInterval> | undefined; if (pollMs) t = setInterval(reload, pollMs); return () => { live.current = false; if (t) clearInterval(t); }; }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload, loading };
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
/** The session lost its passkey unlock (expired, reset by an admin): the shell shows the passkey screen again. */
export const LOCKED_EVENT = 'aerotrace:locked';
const lockedIf = (e: unknown) => { const c = codeOf(e); if (c === 'passkey_required' || c === 'passkey_enroll' || (e as { status?: number })?.status === 401) dispatchEvent(new Event(LOCKED_EVENT)); };

/** Runs an action with a toast. If the server asks for a fresh passkey check, prompts for it once and retries. */
export function useAction() {
  const { say, api, bump } = useApp(); const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      let v: T;
      try { v = await fn(); }
      catch (e) {
        if (codeOf(e) !== 'step_up_required') throw e;
        say('Confirm with your passkey to continue.');
        await api.verifyPasskey(); bump();
        v = await fn();
      }
      if (ok) say(ok); return v;
    } catch (e) { lockedIf(e); say(e instanceof Error ? e.message : String(e), true); return undefined; } finally { setBusy(null); }
  }, [say, api, bump]);
  return { busy, run };
}

export const fmt = (n: number) => n.toLocaleString('en-US');
export const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
export const ago = (iso: string) => { const s = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const until = (iso?: string | null) => { if (!iso) return 'paused'; const s = Math.round((Date.parse(iso) - Date.now()) / 1000); if (s <= 0) return 'due now'; return s < 3600 ? `in ${Math.round(s / 60)} min` : s < 86400 ? `in ${Math.round(s / 3600)} h` : `in ${Math.round(s / 86400)} d`; };

export function Verdict({ v, lg }: { v?: string | null; lg?: boolean }) { return v ? <span className={`verdict v-${v}` + (lg ? ' lg' : '')}>{v}</span> : <span className="pill">–</span>; }
const STATUS: Record<string, [string, string]> = { queued: ['Queued', ''], running: ['Running', 'acc'], failed: ['Failed', 'bad'], awaiting_approval: ['Awaiting approval', 'warn'], approved: ['Approved', 'ok'], denied: ['Denied', 'bad'] };
export function Status({ s }: { s: string }) { const [l, c] = STATUS[s] ?? [s, '']; return <span className={`pill ${c}`}>{s === 'running' && <span className="spin sm" />}{l}</span>; }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><b>{title}</b>{children}</div>; }
export function Loading({ what = 'Loading' }: { what?: string }) { return <div className="row dim"><span className="spin" /> {what}…</div>; }
export function ErrorBox({ error }: { error: string }) { return <div className="empty err-box"><b>That didn't load.</b><span>{error}</span></div>; }
export function Head({ title, eyebrow, children, actions }: { title: string; eyebrow?: string; children?: ReactNode; actions?: ReactNode }) {
  return <div className="pagehead"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{children && <p>{children}</p>}</div>{actions && <div className="row">{actions}</div>}</div>;
}

export function Checks<T extends string>({ options, value, onChange, label, disabled }: { options: { id: T; label: string; hint?: string }[]; value: T[]; onChange: (v: T[]) => void; label: string; disabled?: boolean }) {
  return <fieldset className="checks" disabled={disabled}><legend>{label}</legend>
    {options.map(o => <label key={o.id} className="check"><input type="checkbox" checked={value.includes(o.id)} onChange={e => onChange(e.target.checked ? [...value, o.id] : value.filter(x => x !== o.id))} /><span>{o.label}{o.hint && <small className="dim"> {o.hint}</small>}</span></label>)}
    {!options.length && <span className="dim">None yet.</span>}
  </fieldset>;
}
export function Field({ label, id, children, hint }: { label: string; id: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <small className="dim">{hint}</small>}</div>;
}
export function Drawer({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return <div className="scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="btn ghost" onClick={onClose} aria-label="Close">Close</button></header>
      <div className="drawer-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </aside></div>;
}
export function Confirm({ text, onYes, children, danger }: { text: string; onYes: () => void; children: ReactNode; danger?: boolean }) {
  const [ask, setAsk] = useState(false);
  if (!ask) return <span onClick={() => setAsk(true)}>{children}</span>;
  return <span className="confirm">{text} <button className={`btn sm ${danger ? 'deny' : 'primary'}`} onClick={() => { setAsk(false); onYes(); }}>Yes</button><button className="btn sm" onClick={() => setAsk(false)}>No</button></span>;
}
export function download(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
