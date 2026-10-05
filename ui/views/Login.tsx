'use client';
import { useEffect, useState } from 'react';
import type { Api } from '../api';

import { passkeysSupported } from '../passkeyBrowser';

export function Login({ api, onDone, notice }: { api: Api; onDone: () => void; notice?: string | null }) {
  const [cfg, setCfg] = useState<{ local: boolean; sso: { label: string } | null; version: string } | null>(null);
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.authConfig().then(setCfg, e => setErr(String(e?.message ?? e))); }, [api]);
  return <main className="center">
    <form className="panel login" onSubmit={async e => { e.preventDefault(); setBusy(true); setErr(null); try { await api.login(email, pw); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } }}>
      <div className="eyebrow">AeroTrace Gate</div>
      <h1>Sign in</h1>
      {notice && <p className="err-text" role="alert">{notice}</p>}
      <p className="dim2">DO-178C audit approvals. Use your company account.</p>
      <button type="button" className="btn primary wide" disabled={busy} onClick={async () => { setBusy(true); setErr(null); try { await api.passkeyLogin(); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } finally { setBusy(false); } }}>Sign in with a passkey</button>
      {!passkeysSupported() && <small className="err-text">This browser can't use passkeys. Use a current Chrome, Edge, Safari or Firefox.</small>}
      <div className="or"><span>first time here, or no passkey yet?</span></div>
      {cfg?.sso && <a className="btn wide" href={api.ssoUrl()!}>{cfg.sso.label}</a>}
      {cfg?.sso && cfg.local && <div className="or"><span>or with a local account</span></div>}
      {cfg?.local !== false && <>
        <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} required /></div>
        <button className="btn wide" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in with password'}</button>
      </>}
      {err && <p className="err-text" role="alert">{err}</p>}
      <small className="dim">Version {cfg?.version ?? '…'}. A password or SSO sign-in still needs your passkey before any audit data opens. After 5 wrong passwords, sign-in pauses for 15 minutes.</small>
    </form>
  </main>;
}

export function ChangePassword({ api, onDone }: { api: Api; onDone: () => void }) {
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState(''); const [err, setErr] = useState<string | null>(null);
  return <main className="center">
    <form className="panel login" onSubmit={async e => { e.preventDefault(); if (next !== again) { setErr('The new passwords do not match.'); return; } try { await api.changePassword(cur, next); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } }}>
      <h1>Choose a new password</h1>
      <p className="dim2">An administrator set a temporary password for you. Pick your own before you continue. At least 12 characters, with letters and a number.</p>
      <div className="field"><label htmlFor="c1">Temporary password</label><input id="c1" type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} required /></div>
      <div className="field"><label htmlFor="c2">New password</label><input id="c2" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} required minLength={12} /></div>
      <div className="field"><label htmlFor="c3">New password again</label><input id="c3" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required /></div>
      <button className="btn primary wide" type="submit">Save password</button>
      {err && <p className="err-text" role="alert">{err}</p>}
    </form>
  </main>;
}
