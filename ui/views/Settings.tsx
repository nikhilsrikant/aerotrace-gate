'use client';
import { useEffect, useState } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Field, Checks } from '../kit';
import { DEFAULT_PASSKEY_POLICY, type Settings } from '../../lib/core/model';
import { PasskeyPolicyPanel } from './Passkey';

const EVENTS = [{ id: 'run.awaiting_approval', label: 'An audit is waiting for approval' }, { id: 'run.approved', label: 'An audit was approved' }, { id: 'run.denied', label: 'An audit was denied' }, { id: 'run.failed', label: 'An audit failed to run' }];
export function SettingsView() {
  const { api, meta } = useApp();
  const { data, error } = useLoad(() => api.settings(), []);
  const [s, setS] = useState<Settings | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { if (data) setS(data); }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!s) return <Loading />;
  return <>
    <Head title="Settings">Secrets such as API keys come from the container's environment, never from this page.</Head>
    <div className="grid2">
      <div className="panel">
        <h2>Organisation</h2>
        <Field label="Name shown in the app" id="s-org"><input id="s-org" value={s.orgName} onChange={e => setS({ ...s, orgName: e.target.value })} /></Field>
        <h2>Layer 2 reader</h2>
        <Field label="Provider" id="s-llm"><select id="s-llm" value={s.llm.provider} onChange={e => setS({ ...s, llm: { ...s.llm, provider: e.target.value as Settings['llm']['provider'] } })}>
          <option value="none">Rule-based reader only (no model)</option><option value="anthropic">Anthropic API (key from ANTHROPIC_API_KEY)</option><option value="openai">OpenAI-compatible endpoint (vLLM, Azure OpenAI, on-prem gateway)</option></select></Field>
        <Field label="Model" id="s-model"><input id="s-model" className="mono" value={s.llm.model} onChange={e => setS({ ...s, llm: { ...s.llm, model: e.target.value } })} /></Field>
        {s.llm.provider === 'openai' && <Field label="Base URL" id="s-base" hint="For an air-gapped site, point this at a model served inside your network."><input id="s-base" className="mono" value={s.llm.baseUrl} onChange={e => setS({ ...s, llm: { ...s.llm, baseUrl: e.target.value } })} placeholder="https://llm.internal.example/v1" /></Field>}
        <small className="dim">Now: {meta.llm.configured ? `${meta.llm.provider} · ${meta.llm.model}` : 'no model configured, so Layer 2 uses the rule-based reader'}. Environment variables LLM_PROVIDER and LLM_MODEL override these.</small>
      </div>
      <div className="panel">
        <h2>Notifications</h2>
        <Field label="Slack incoming webhook" id="s-sl"><input id="s-sl" className="mono" value={s.notifications.slackUrl} onChange={e => setS({ ...s, notifications: { ...s.notifications, slackUrl: e.target.value } })} placeholder="https://hooks.slack.com/services/…" /></Field>
        <Field label="Microsoft Teams webhook" id="s-tm"><input id="s-tm" className="mono" value={s.notifications.teamsUrl} onChange={e => setS({ ...s, notifications: { ...s.notifications, teamsUrl: e.target.value } })} /></Field>
        <Field label="Generic JSON webhook" id="s-wh" hint="Receives event, runId, module, verdict, status, link and the list of approvers."><input id="s-wh" className="mono" value={s.notifications.webhookUrl} onChange={e => setS({ ...s, notifications: { ...s.notifications, webhookUrl: e.target.value } })} /></Field>
        <Checks label="Send these events" options={EVENTS} value={s.notifications.events} onChange={v => setS({ ...s, notifications: { ...s.notifications, events: v } })} />
        <h2>Signing</h2>
        <p className="sm" style={{ margin: 0 }}>Decisions are signed with <b>{meta.signer.alg}</b>, key <span className="mono">{meta.signer.keyId}</span>. The public key is at <span className="mono">/api/keys</span> so auditors can verify signatures outside this system.</p>
      </div>
    </div>
    <div className="grid2"><PasskeyPolicyPanel value={s.passkeys ?? DEFAULT_PASSKEY_POLICY} onChange={p => setS({ ...s, passkeys: p })} /></div>
    <div className="row"><button className="btn primary" disabled={busy === 'save'} onClick={() => run('save', () => api.saveSettings(s), 'Settings saved.')}>Save settings</button></div>
  </>;
}
