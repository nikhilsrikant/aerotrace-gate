'use client';
import { useCallback, useEffect, useState } from 'react';
import type { Api, Me, Meta, Directory } from './api';
import { Ctx, type AppCtx } from './kit';
import { Login, ChangePassword } from './views/Login';
import { Approvals } from './views/Approvals';
import { Runs } from './views/Runs';
import { RunDetail } from './views/RunDetail';
import { NewAudit } from './views/NewAudit';
import { Schedules } from './views/Schedules';
import { Datasets } from './views/Datasets';
import { Policies } from './views/Policies';
import { Delegations } from './views/Delegations';
import { Access } from './views/Access';
import { Tokens } from './views/Tokens';
import { SettingsView } from './views/Settings';
import { AuditLog } from './views/AuditLog';
import { Assistant } from './views/Assistant';
import { ProgramView } from './views/Program';
import { WorkspacesView } from './views/Workspaces';
import { PasskeyGate, DemoDevicePrompt, PasskeyStatus, SecurityView } from './views/Passkey';
import { LOCKED_EVENT } from './kit';
import type { Permission } from '../lib/core/model';

type Page = { id: string; label: string; perm?: Permission; group: string };
const PAGES: Page[] = [
  { id: 'approvals', label: 'Approvals', group: 'Work' },
  { id: 'program', label: 'Program readiness', perm: 'audit.view', group: 'Work' },
  { id: 'runs', label: 'All audits', perm: 'audit.view', group: 'Work' },
  { id: 'new', label: 'Run an audit', perm: 'audit.request', group: 'Work' },
  { id: 'schedules', label: 'Schedules', perm: 'audit.view', group: 'Automation' },
  { id: 'datasets', label: 'Evidence datasets', perm: 'audit.view', group: 'Automation' },
  { id: 'policies', label: 'Approval policies', group: 'Authority' },
  { id: 'delegations', label: 'Delegations', group: 'Authority' },
  { id: 'access', label: 'Users, groups, roles', perm: 'access.manage', group: 'Admin' },
  { id: 'tokens', label: 'API tokens', group: 'Admin' },
  { id: 'settings', label: 'Settings', perm: 'settings.manage', group: 'Admin' },
  { id: 'auditlog', label: 'Audit log', perm: 'auditlog.view', group: 'Admin' },
  { id: 'workspaces', label: 'Workspaces', group: 'Admin' },
  { id: 'security', label: 'Security and passkeys', group: 'You' },
];
const hashNow = () => (typeof location === 'undefined' ? '' : location.hash.slice(1)) || 'approvals';

function Logo() {
  return <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="6" fill="none" stroke="currentColor" strokeOpacity=".35" />
    <path d="M6 15.5 L11 18.5 L20 7.5" fill="none" stroke="#8a9bff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export default function App({ api }: { api: Api }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [dir, setDir] = useState<Directory>({ users: [], groups: [] });
  const [hash, setHash] = useState('approvals');
  const [toast, setToast] = useState<{ text: string; err?: boolean } | null>(null);
  const [pending, setPending] = useState(0);
  const [tick, setTick] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const [demoUsers, setDemoUsers] = useState<{ id: string; name: string; summary: string }[]>([]);

  const say = useCallback((text: string, err = false) => { setToast({ text, err }); setTimeout(() => setToast(t => (t?.text === text ? null : t)), 4500); }, []);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    // Opening an invite link: #invite=<token>. Redeem it once, then drop it from the address bar.
    const inv = typeof location !== 'undefined' && location.hash.startsWith('#invite=') ? location.hash.slice(8) : null;
    if (inv) { history.replaceState(null, '', location.pathname + location.search); try { await api.redeemInvite(inv); } catch (e) { setInviteErr(e instanceof Error ? e.message : String(e)); } }
    const m = await api.me().catch(() => null); setMe(m);
    const unlocked = m && !(m.assurance?.required && !m.assurance.verified);
    if (unlocked) { const [mt, d] = await Promise.all([api.meta(), api.directory()]); setMeta(mt); setDir(d); }
    if (api.demoUsers) setDemoUsers(await api.demoUsers());
  }, [api]);
  useEffect(() => { const relock = () => { load(); }; addEventListener(LOCKED_EVENT, relock); return () => removeEventListener(LOCKED_EVENT, relock); }, [load]);
  useEffect(() => { load(); setHash(hashNow()); const on = () => setHash(hashNow()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, [load]);
  useEffect(() => {
    if (!me) return; let live = true;
    const poll = async () => { try { const ib = await api.inbox(); if (live) setPending(ib.mine.length); } catch { /* signed out */ } };
    if (me.assurance?.required && !me.assurance.verified) return;
    poll(); const t = setInterval(poll, 8000); return () => { live = false; clearInterval(t); };
  }, [api, me, tick]);
  const go = useCallback((h: string) => { if (location.hash.slice(1) !== h) location.hash = h; setHash(h); window.scrollTo?.(0, 0); }, []);

  if (me === undefined) return <main className="center"><span className="spin" /></main>;
  if (me === null) return <Login api={api} onDone={load} notice={inviteErr} />;
  if (me.mustChangePassword) return <ChangePassword api={api} onDone={load} />;
  if (me.assurance?.required && !me.assurance.verified) return <><PasskeyGate api={api} me={me} onDone={load} onSignOut={api.switchUser ? undefined : async () => { await api.logout(); setMe(null); }} />{api.switchUser && <DemoSwitcher api={api} me={me} users={demoUsers} onSwitch={async id => { await api.switchUser!(id); await load(); }} />}</>;
  if (!meta) return <main className="center"><span className="spin" /></main>;

  const perms = new Set(me.permissions);
  const can = (p: Permission) => perms.has(p);
  const ctx: AppCtx = { api, me, meta, dir, refreshDir: async () => setDir(await api.directory()), say, go, can, bump: () => setTick(t => t + 1), tick, focus, setFocus };
  const visible = PAGES.filter(p => (!p.perm || can(p.perm)) && (p.id !== 'workspaces' || meta.platformAdmin || (meta.workspaces?.length ?? 0) > 1));
  const page = hash.startsWith('run_') ? 'run' : visible.some(p => p.id === hash) ? hash : 'approvals';
  const groups = [...new Set(visible.map(p => p.group))];

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <aside className="rail">
          <div className="brand"><Logo /><div><b>AeroTrace Gate</b><small>{meta.workspace?.name ?? meta.orgName}</small></div></div>
          {(meta.workspaces?.length ?? 0) > 1 && <div className="ws-switch"><label htmlFor="ws">Workspace</label>
            <select id="ws" value={meta.workspace?.id} onChange={async e => { await api.switchWorkspace(e.target.value); setFocus(null); go('approvals'); await load(); setTick(t => t + 1); }}>
              {meta.workspaces!.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></div>}
          <nav className="nav" aria-label="Main">
            {groups.map(g => <div key={g} className="navgroup"><span className="navlabel">{g}</span>
              {visible.filter(p => p.group === g).map(p => <button key={p.id} aria-current={page === p.id || (page === 'run' && p.id === 'runs') ? 'page' : undefined} onClick={() => go(p.id)}>
                {p.label}{p.id === 'approvals' && <span className={'count' + (pending ? ' hot' : '')}>{pending}</span>}</button>)}
            </div>)}
          </nav>
          <div className="rail-foot">
            {api.switchUser ? <><label htmlFor="who">Signed in as (demo)</label>
              <select id="who" value={me.user.id} onChange={async e => { await api.switchUser!(e.target.value); await load(); setTick(t => t + 1); }}>
                {demoUsers.map(u => <option key={u.id} value={u.id}>{u.name} · {u.summary}</option>)}</select></>
              : <><span>Signed in as</span><span className="who">{me.user.name}</span><span className="dim2">{me.user.email}</span>
                <button className="link" onClick={async () => { await api.logout(); setMe(null); }}>Sign out</button></>}
            <PasskeyStatus />
            <span className="envchip"><i />{meta.store} · {meta.signer.alg} · {/^\d/.test(meta.version) ? `v${meta.version}` : meta.version}</span>
          </div>
        </aside>
        <main>
          {page === 'approvals' && <Approvals />}
          {page === 'program' && <ProgramView />}
          {page === 'runs' && <Runs />}
          {page === 'run' && <RunDetail key={hash} id={hash} />}
          {page === 'new' && <NewAudit />}
          {page === 'schedules' && <Schedules />}
          {page === 'datasets' && <Datasets />}
          {page === 'policies' && <Policies />}
          {page === 'delegations' && <Delegations />}
          {page === 'access' && <Access />}
          {page === 'tokens' && <Tokens />}
          {page === 'settings' && <SettingsView />}
          {page === 'auditlog' && <AuditLog />}
          {page === 'security' && <SecurityView />}
          {page === 'workspaces' && <WorkspacesView />}
        </main>
        {toast && <div className={'toast' + (toast.err ? ' err' : '')} role="status">{toast.text}</div>}
      </div>
      <Assistant runId={page === 'run' ? hash : undefined} />
      <DemoDevicePrompt />
    </Ctx.Provider>
  );
}

/** Demo only: switch person from the passkey screen too. */
function DemoSwitcher({ me, users, onSwitch }: { api: Api; me: Me; users: { id: string; name: string; summary: string }[]; onSwitch: (id: string) => Promise<void> }) {
  return <div className="demo-switch"><label htmlFor="who2">Demo: signed in as</label>
    <select id="who2" value={me.user.id} onChange={e => onSwitch(e.target.value)}>{users.map(u => <option key={u.id} value={u.id}>{u.name} · {u.summary}</option>)}</select></div>;
}
