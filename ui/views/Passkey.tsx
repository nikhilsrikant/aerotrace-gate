'use client';
// Passkey screens: the gate before any audit data, the Security page, the policy panel in Settings,
// the status line in the rail, and the stand-in device prompt used only by the browser demo.
import { useEffect, useState } from 'react';
import type { Api, Me } from '../api';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Field, Checks, Confirm, when } from '../kit';
import { onPrompt, type PromptRequest } from '../demoPrompt';
import type { PasskeyPolicy, StepUpAction } from '../../lib/core/model';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Shown instead of the app until this session is unlocked with a passkey. */
export function PasskeyGate({ api, me, onDone, onSignOut }: { api: Api; me: Me; onDone: () => void; onSignOut?: () => void }) {
  const has = (me.assurance?.passkeys ?? 0) > 0;
  const canEnroll = me.assurance?.canEnroll !== false; const viaInvite = me.assurance?.method === 'invite';
  const hw = me.assurance?.hardwareOnly ? me.assurance.allowedAuthenticators ?? [] : null;
  const [name, setName] = useState(guessDevice());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const go = async () => { setBusy(true); setErr(null); try { if (has) await api.verifyPasskey(); else await api.enrollPasskey(name); onDone(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); } };
  return <main className="center">
    <div className="panel login gate">
      <div className="key-badge" aria-hidden="true"><KeyIcon /></div>
      <div className="eyebrow">Signed in as {me.user.name}</div>
      <h1>{has ? 'Confirm it\'s you' : canEnroll ? (viaInvite ? `Welcome, ${me.user.name.split(' ')[0]}` : 'Set up your passkey') : 'You need an invite link'}</h1>
      {has
        ? <p className="dim2">Audit data is only shown after you confirm with your passkey: fingerprint, face, PIN or security key. Your password alone isn't enough.</p>
        : !canEnroll ? <p className="dim2">Your first passkey is set up from a one-time invite link, so nobody who learns your password can enrol a passkey in your name. Ask an administrator to send you one. It works once and expires.</p>
        : <><p className="dim2">{viaInvite ? 'You opened your invite link. ' : ''}Every engineer needs a passkey to see audit data and to sign decisions. It lives on your device: your laptop's fingerprint reader, Windows Hello, your phone or a security key. Nobody, including us, ever sees the private key.</p>
          {hw && <p className="sm" style={{ margin: 0 }}><b>Approved security keys only:</b> {hw.join(', ') || 'see your administrator'}. Other devices will be refused.</p>}
          <Field label="Name this passkey" id="pk-name" hint="So you can tell your passkeys apart later."><input id="pk-name" value={name} onChange={e => setName(e.target.value)} maxLength={60} /></Field></>}
      {(has || canEnroll) && <button className="btn primary wide" disabled={busy} onClick={go}>{busy ? 'Waiting for your device…' : has ? 'Use my passkey' : 'Create passkey'}</button>}
      {err && <p className="err-text" role="alert">{err}</p>}
      <small className="dim">{has ? 'Lost your device? Ask an administrator to reset your passkeys, then set up a new one.' : 'You can add more passkeys later, for example a backup security key, on the Security page.'}</small>
      {onSignOut && <button className="link" onClick={onSignOut}>Sign out</button>}
    </div>
    <DemoDevicePrompt />
  </main>;
}

/** Browser demo only: stands in for the operating system's passkey dialog. */
export function DemoDevicePrompt() {
  const [req, setReq] = useState<PromptRequest | null>(null);
  useEffect(() => onPrompt(setReq), []);
  if (!req) return null;
  return <div className="scrim center-scrim" role="dialog" aria-modal="true" aria-label="Passkey prompt">
    <div className="device-prompt">
      <div className="fp" aria-hidden="true"><FingerprintIcon /></div>
      <b>{req.title}</b>
      <span>{req.who}</span>
      <p className="sm dim2">{req.detail}</p>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn primary" autoFocus onClick={() => req.resolve(true)}>Use passkey</button>
        <button className="btn" onClick={() => req.resolve(false)}>Cancel</button>
      </div>
      <small className="dim">Simulated device. In the deployed app, your laptop, phone or security key asks for your fingerprint, face or PIN here.</small>
    </div>
  </div>;
}

/** Small status line under the signed-in person in the rail. */
export function PasskeyStatus() {
  const { me, go } = useApp(); const a = me.assurance;
  if (!a) return null;
  const fresh = a.stepUpUntil && Date.parse(a.stepUpUntil) > Date.now();
  return <button className="pk-status" onClick={() => go('security')} title="Your passkeys and session">
    <KeyIcon small /> {a.verified ? <>Passkey verified {when(a.verifiedAt)}{fresh ? '' : ' · will ask again for sensitive steps'}</> : 'Passkey not verified'}
  </button>;
}

export function SecurityView() {
  const { api, me, bump } = useApp();
  const { data, error, reload } = useLoad(() => api.passkeys(), []);
  const [name, setName] = useState(guessDevice());
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const { busy, run } = useAction();
  const a = me.assurance;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return <>
    <Head title="Security">Your passkeys. Each one is a key pair: the private half never leaves your device, and this app only stores the public half. You'll be asked for a passkey to open audit data, to approve or deny, and for sensitive steps.</Head>
    <div className="grid2">
      <div className="panel">
        <h2>This session</h2>
        <dl className="kvlist">
          <dt>Signed in with</dt><dd>{a?.method === 'passkey' ? 'Passkey' : a?.method === 'sso' ? 'Single sign-on' : 'Password'}</dd>
          <dt>Passkey check</dt><dd>{a?.verifiedAt ? when(a.verifiedAt) : 'not yet'}</dd>
          <dt>Sensitive steps</dt><dd>{a?.stepUpUntil && Date.parse(a.stepUpUntil) > Date.now() ? `allowed until ${when(a.stepUpUntil)}` : `will ask for your passkey (window: ${a?.stepUpMinutes ?? 5} min)`}</dd>
          <dt>Decisions</dt><dd>{a?.signDecisions ? 'Each Approve or Deny is signed by your passkey' : 'Signed by the gate only'}</dd>
        </dl>
        <div className="row"><button className="btn" disabled={busy === 'v'} onClick={() => run('v', async () => { await api.verifyPasskey(); bump(); }, 'Confirmed.')}>Confirm now</button></div>
      </div>
      <div className="panel">
        <h2>Add a passkey</h2>
        <p className="sm dim2" style={{ margin: 0 }}>Add a second one, such as a security key in your drawer, so losing a laptop doesn't lock you out.</p>
        <Field label="Name" id="pk-new"><input id="pk-new" value={name} onChange={e => setName(e.target.value)} maxLength={60} /></Field>
        <div className="row"><button className="btn primary" disabled={busy === 'add'} onClick={() => run('add', async () => { await api.enrollPasskey(name); await reload(); bump(); }, 'Passkey added.')}>Add passkey</button></div>
      </div>
    </div>
    <div className="tbl"><table><thead><tr><th>Passkey</th><th>Kind</th><th>Added</th><th>Last used</th><th /></tr></thead><tbody>
      {data.map(p => <tr key={p.id}>
        <td>{rename?.id === p.id
          ? <form className="row" onSubmit={e => { e.preventDefault(); run('r' + p.id, async () => { await api.renamePasskey(p.id, rename.name); setRename(null); await reload(); }, 'Renamed.'); }}><input value={rename.name} onChange={e => setRename({ ...rename, name: e.target.value })} autoFocus maxLength={60} /><button className="btn sm primary">Save</button></form>
          : <><b style={{ fontWeight: 600 }}>{p.name}</b>{p.id === me.assurance?.passkeyId && <span className="pill acc" style={{ marginLeft: 6 }}>this session</span>}<div className="mono dim sm">{p.id.slice(0, 16)}…</div></>}</td>
        <td className="sm">{p.attested ? <span className="pill ok" title="Vendor attestation verified against a pinned root">Verified {p.model}</span> : p.deviceType === 'multiDevice' ? 'Synced passkey' : 'Device-bound (security key)'}{p.backedUp ? ' · backed up' : ''}</td>
        <td className="sm">{when(p.createdAt)}</td><td className="sm">{when(p.lastUsedAt)}</td>
        <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <button className="btn sm" onClick={() => setRename({ id: p.id, name: p.name })}>Rename</button>
          <Confirm text={`Remove "${p.name}"? You'll need another passkey to sign in.`} danger onYes={() => run('d' + p.id, async () => { await api.removePasskey(p.id); await reload(); bump(); }, 'Passkey removed.')}><button className="btn sm ghost">Remove</button></Confirm>
        </div></td>
      </tr>)}
    </tbody></table></div>
    {!data.length && <p className="dim">No passkeys yet.</p>}
    <small className="dim">Lost a device? Remove it here from another passkey, or ask an administrator to reset your passkeys.</small>
  </>;
}

/** Settings panel: how strict passkey checks are. */
export function PasskeyPolicyPanel({ value, onChange }: { value: PasskeyPolicy; onChange: (p: PasskeyPolicy) => void }) {
  const { meta } = useApp();
  const opts = (meta.stepUpActions ?? []).map(x => ({ id: x.id as StepUpAction, label: x.label }));
  return <div className="panel">
    <h2>Passkeys</h2>
    <label className="check"><input type="checkbox" checked={value.required} onChange={e => onChange({ ...value, required: e.target.checked })} /><span>Require a passkey before anyone sees audit data<small className="dim"> Password and SSO sign-ins stop at the passkey screen.</small></span></label>
    <label className="check"><input type="checkbox" checked={value.signDecisions} onChange={e => onChange({ ...value, signDecisions: e.target.checked })} /><span>Approvers sign every Approve and Deny with their passkey<small className="dim"> The signature covers the report hash and goes into the evidence package. API tokens can never decide.</small></span></label>
    <Field label="Ask again for sensitive steps after (minutes)" id="pk-min"><input id="pk-min" type="number" min={1} max={240} value={value.stepUpMinutes} onChange={e => onChange({ ...value, stepUpMinutes: Number(e.target.value) })} /></Field>
    <Checks label="Sensitive steps that need a recent passkey check" options={opts} value={value.stepUpFor} onChange={v => onChange({ ...value, stepUpFor: v })} />
    <Field label="How people get their first passkey" id="pk-enrol"><select id="pk-enrol" value={value.enrollment} onChange={e => onChange({ ...value, enrollment: e.target.value as PasskeyPolicy['enrollment'] })}>
      <option value="invite_or_sso">From an invite link, or right after an SSO sign-in (recommended)</option>
      <option value="invite">Only from an invite link</option>
      <option value="any">After any sign-in, including a password (weakest)</option></select></Field>
    <h3>Approved security keys</h3>
    <p className="sm dim2" style={{ margin: 0 }}>Leave empty to accept any passkey. Add models by AAGUID (from the vendor's FIDO metadata) to accept only those, for example company-issued keys for DER sign-off. A key must prove its model with a vendor certificate that chains to a root below; without a root, no key can be proven and enrolment is refused.</p>
    {value.allowedAuthenticators.map((x, i) => <div key={i} className="row" style={{ gap: 6 }}>
      <input aria-label="Model name" placeholder="Model name" value={x.name} onChange={e => onChange({ ...value, allowedAuthenticators: value.allowedAuthenticators.map((y, j) => j === i ? { ...y, name: e.target.value } : y) })} style={{ flex: 1 }} />
      <input aria-label="AAGUID" className="mono" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" value={x.aaguid} onChange={e => onChange({ ...value, allowedAuthenticators: value.allowedAuthenticators.map((y, j) => j === i ? { ...y, aaguid: e.target.value } : y) })} style={{ flex: 2 }} />
      <button className="btn sm ghost" onClick={() => onChange({ ...value, allowedAuthenticators: value.allowedAuthenticators.filter((_, j) => j !== i) })}>Remove</button></div>)}
    <div className="row"><button className="btn sm" onClick={() => onChange({ ...value, allowedAuthenticators: [...value.allowedAuthenticators, { name: '', aaguid: '' }] })}>Add a model</button></div>
    <Field label="Attestation root certificates (PEM)" id="pk-roots" hint="Paste the vendor's published attestation root, one or more certificates.">
      <textarea id="pk-roots" className="mono" rows={4} value={value.attestationRoots.join('\n')} placeholder="-----BEGIN CERTIFICATE-----" onChange={e => onChange({ ...value, attestationRoots: e.target.value.split(/(?<=-----END CERTIFICATE-----)\s*/).map(x => x.trim()).filter(Boolean) })} /></Field>
    {value.allowedAuthenticators.length > 0 && !value.attestationRoots.length && <p className="err-text sm" style={{ margin: 0 }}>Add at least one root certificate, or nobody will be able to enrol.</p>}
    {!value.required && <p className="err-text sm" style={{ margin: 0 }}>With this off, a stolen password is enough to read audit data. The change is written to the audit log.</p>}
  </div>;
}

function guessDevice() {
  if (typeof navigator === 'undefined') return 'This device';
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac (Touch ID)' : /Windows/.test(ua) ? 'Windows Hello' : 'This device';
}
function KeyIcon({ small }: { small?: boolean }) {
  const s = small ? 14 : 30;
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2" /></svg>;
}
function FingerprintIcon() {
  return <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M12 11v3M8.5 9.5A4 4 0 0 1 16 11v1.5M7.5 13.5c0 2.4.7 4.3 2 6M12 4a7 7 0 0 0-7 7v1M19 11a7 7 0 0 0-3-5.7M16.3 15c-.2 2-.8 3.6-1.8 5M12 17.5c0 1.2-.2 2.3-.6 3.3" /></svg>;
}
