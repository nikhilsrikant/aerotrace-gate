// The browser demo: the real Services, policy engine, scheduler and agents over an in-memory store,
// with a background "worker" loop so runs queue, progress and finish exactly as they do on the server.
import { ApiError, type Api, type Meta } from './api';
import { MemRepo } from '../lib/core/memRepo';
import { Services } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { PERMISSIONS, STEP_UP_ACTIONS, DEFAULT_WORKSPACE, type Actor, type Session } from '../lib/core/model';
import { describeRecurrence } from '../lib/core/schedule';
import { sha256, randomId } from '../lib/engine';
import { SoftAuthenticator } from '../lib/testing/softAuthenticator';
import { askDevice } from './demoPrompt';

// The demo's passkeys live on simulated devices, one per person. The server-side checks are the real ones.
const RP = { id: 'gate.aerotrace.demo', origin: 'https://gate.aerotrace.demo' };

export function createLocalApi(): Api {
  const repo = new MemRepo();
  // root: the whole store (worker, scheduler, workspace admin). svc: the signed-in person's current workspace.
  let root!: Services; let svc!: Services; let current = 'usr_priya'; let shift = 0;   // lets the demo seed a few days of history
  let sessionId = '';
  const devices = new Map<string, SoftAuthenticator>();
  const device = (uid: string) => { let d = devices.get(uid); if (!d) { d = new SoftAuthenticator(RP.origin); devices.set(uid, d); } return d; };
  const openSession = async (userId: string, method: Session['method'] = 'password') => {
    const now = new Date(); const sess: Session = { id: randomId('ses'), tokenHash: randomId('t'), userId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 12 * 3600e3).toISOString(), method, passkeyAt: null };
    await repo.createSession(sess); return sess.id;
  };
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const ready = (async () => {
    svc = new Services({ repo, signer: await hmacSigner('browser-demo'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, pace: 30, now: () => new Date(Date.now() + shift), rp: st => ({ id: RP.id, name: st.orgName, origins: [RP.origin] }) });
    root = svc;
    const s = await seed(repo, svc, { demoUsers: true, syntheticDataset: true, hash: p => sha256(p) });
    const marcus = await svc.actorFor((await repo.getUser('usr_marcus'))!);
    // Marcus has been auditing FUEL-MON by hand every morning: the app should offer to automate it.
    const today9 = new Date(); today9.setHours(9, 0, 0, 0);
    for (const d of [4, 3, 2, 1]) { shift = today9.getTime() - Date.now() - d * 86400e3 + (d % 2 ? 6 : -4) * 60e3; await svc.startAudits(marcus, { datasetId: s.datasetId!, modules: ['FUEL-MON'], layer2: 'heuristic' }); }
    shift = 0;
    await svc.startAudits(marcus, { datasetId: s.datasetId!, modules: ['BARO-IN', 'ALT-ALERT', 'TERR-DB'], layer2: 'heuristic' });
    const sam = await svc.actorFor((await repo.getUser('usr_sam'))!);
    await svc.saveSchedule(sam, { name: 'Nightly safety-critical sweep', datasetId: s.datasetId!, modules: ['BARO-*', 'ALT-ALERT', 'AOA-MON', 'STALL-WARN'], layer2: 'heuristic', recurrence: { kind: 'daily', time: '02:00' }, timezone: 'America/Phoenix', enabled: true, skipIfPending: true, notifyOn: ['NO', 'failed'] });
    const sweep = await svc.saveSchedule(sam, { name: 'Every 24 hours: all modules', datasetId: s.datasetId!, modules: ['*'], layer2: 'heuristic', recurrence: { kind: 'interval', everyMinutes: 1440 }, timezone: 'UTC', enabled: false, skipIfPending: true, notifyOn: ['NO', 'failed'] });
    // Everyone except Jordan already has a passkey on their (simulated) laptop; Jordan shows first-time enrolment.
    const names: Record<string, string> = { usr_sam: 'YubiKey 5C', usr_priya: 'MacBook Touch ID', usr_dana: 'Windows Hello', usr_marcus: 'Pixel phone' };
    for (const [uid, name] of Object.entries(names)) {
      const a = (await svc.actorForSession((await repo.sessions.get(await openSession(uid, 'invite')))!))!;
      const o = await svc.beginPasskeyRegistration(a); await svc.finishPasskeyRegistration(a, o.challengeId, await device(uid).create(o.options), name);
    }
    // A second program in its own workspace: Sam (platform admin) and Dana belong to it; Priya and Marcus don't see it.
    await repo.updateUser('usr_sam', { platformAdmin: true });
    const samRoot = await root.actorFor((await repo.getUser('usr_sam'))!);
    const fcc = await root.createWorkspace(samRoot, { name: 'FCC-2 Flight Controls' });
    const w = root.forWorkspace(fcc.id); const samW = await w.actorFor((await repo.getUser('usr_sam'))!);
    const reviewers = (await w.listGroups())[0];
    await w.d.repo.updateUser('usr_dana', { roleIds: ['role_auditor'], groupIds: [reviewers.id] });
    const fds = await w.createSyntheticDataset(samW, 'FCC-2 flight control computer (synthetic)', 179);
    await w.startAudits(samW, { datasetId: fds.id, modules: ['FLAP-POS', 'YAW-DAMP', 'TRIM-CTL', 'AP-MODE'], layer2: 'heuristic' });
    svc = root.forWorkspace(DEFAULT_WORKSPACE);
    sessionId = await openSession(current);   // signed in with a password: the passkey gate shows first
    // Last night's sweep of every module, so the program dashboard starts full. It fills in live as the workers finish.
    await svc.runScheduleNow(sam, sweep.id);
    for (let k = 0; k < 4; k++) work(); setInterval(() => root.tickSchedules().catch(() => {}), 5000);
  })();
  async function work() {
    for (;;) {
      const j = await repo.claimJob('browser');
      if (!j) { await new Promise(r => setTimeout(r, 250)); continue; }
      try { if (j.kind === 'audit') await root.executeAudit(String(j.payload.runId), j.attempts, j.maxAttempts); await repo.finishJob(j.id, true); }
      catch (e) { await repo.finishJob(j.id, false, String(e), 500); }
    }
  }
  // raw(): who is signed in. me(): the same, but only once the session is unlocked with a passkey (the data gate).
  const raw = async (): Promise<Actor> => { await ready; const sess = repo.sessions.get(sessionId); if (!sess) throw new ApiError('You were signed out.', 401); return (await svc.actorForSession(sess))!; };
  const me = async (): Promise<Actor> => { const a = await raw(); await svc.assertAccess(a); return a; };
  const cancelled = () => new ApiError('The passkey prompt was closed. Try again.', 400, 'passkey_cancelled');
  const touch = async (a: Actor, title: string, detail: string) => { if (!(await askDevice(title, a.user.name, detail))) throw cancelled(); };
  const unsupported = async (): Promise<never> => { throw new Error('Not available in the browser demo. Deploy the containers for this.'); };
  return {
    mode: 'browser',
    authConfig: async () => ({ local: true, sso: null, version: 'demo' }),
    me: async () => { const a = await raw(); return { user: a.user, permissions: [...a.permissions], assurance: await svc.assurance(a) }; },
    passkeyLogin: async () => { await ready; const o = await svc.beginPasskeyLogin(); const r = await svc.finishPasskeyLogin(o.challengeId, await device(current).get(o.options), 'browser'); const sess = await openSession(r.user.id); await repo.updateSession(sess, { method: 'passkey', passkeyAt: new Date().toISOString(), passkeyId: r.passkeyId }); sessionId = sess; },
    enrollPasskey: async name => { const a = await raw(); const o = await svc.beginPasskeyRegistration(a); await touch(a, 'Create a passkey', 'Your device will keep the private key. Only the public key is sent.'); return svc.finishPasskeyRegistration(a, o.challengeId, await device(a.user.id).create(o.options), name) as never; },
    verifyPasskey: async () => { const a = await raw(); const o = await svc.beginPasskeyVerify(a); await touch(a, 'Sign in to AeroTrace Gate', 'Confirm it\'s you to open audit data.'); await svc.finishPasskeyVerify(a, o.challengeId, await device(a.user.id).get(o.options)); },
    passkeys: async () => svc.myPasskeys(await me()) as never,
    renamePasskey: async (id, name) => svc.renamePasskey(await me(), id, name),
    removePasskey: async id => svc.removePasskey(await me(), id),
    resetPasskeys: async id => { const r = await svc.resetPasskeys(await me(), id); devices.delete(id); return { ...r, invite: { ...r.invite, url: `${location.href.split('#')[0]}#invite=${r.invite.token}` } }; },
    login: async () => {}, logout: async () => {}, changePassword: unsupported, ssoUrl: () => null,
    demoUsers: async () => { await ready; const g = await repo.listGroups(); const r = await repo.listRoles(); return (await repo.listUsers()).map(u => ({ id: u.id, name: u.name, summary: [...u.roleIds.map(x => r.find(y => y.id === x)?.name), ...u.groupIds.map(x => g.find(y => y.id === x)?.name)].filter(Boolean).join(', ') || 'No roles' })); },
    // Someone without a passkey arrives through their invite link; everyone else signs in with a password and meets the passkey gate.
    switchUser: async id => {
      await ready; current = id; sessionId = await openSession(id, (await repo.listPasskeys(id)).length ? 'password' : 'invite');
      const first = (await root.workspacesFor((await repo.getUser(id))!))[0]; svc = root.forWorkspace(first?.id ?? DEFAULT_WORKSPACE);
    },
    workspaces: async () => { const a = await raw(); return { current: svc.workspaceId, platformAdmin: !!a.platformAdmin, workspaces: await root.workspacesFor(a.user) }; },
    switchWorkspace: async id => { const a = await raw(); await svc.switchWorkspace(a, id); svc = root.forWorkspace(id); },
    createWorkspace: async name => svc.createWorkspace(await me(), { name }),
    renameWorkspace: async (id, name) => svc.renameWorkspace(await me(), id, name),
    createInvite: async (id, hours) => { const r = await svc.createInvite(await me(), id, hours); return { ...r, url: `${location.href.split('#')[0]}#invite=${r.token}` }; },
    redeemInvite: async token => { await ready; const u = await svc.redeemInvite(token, 'browser'); current = u.id; sessionId = await openSession(u.id, 'invite'); },
    meta: async (): Promise<Meta> => { const a = await raw(); const wss = await root.workspacesFor(a.user); return { workspace: wss.find(x => x.id === svc.workspaceId), workspaces: wss, platformAdmin: !!a.platformAdmin, version: 'browser demo', orgName: (await svc.getSettings()).orgName, llm: { provider: 'none', model: 'rule-based reader', configured: false }, store: 'browser memory', signer: { alg: 'HS256', keyId: svc.d.signer.keyId }, permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ id: id as never, label })), sso: false, me: a.user, stepUpActions: Object.entries(STEP_UP_ACTIONS).map(([id, label]) => ({ id, label })) } as Meta; },
    directory: async () => { await ready; return { users: await svc.directoryNames(), groups: (await svc.listGroups()).map(g => ({ id: g.id, name: g.name })) }; },
    datasets: async () => { await ready; return svc.listDatasets(); },
    uploadDataset: unsupported,
    createSynthetic: async (name, seedN) => svc.createSyntheticDataset(await me(), name, seedN),
    deleteDataset: async id => svc.deleteDataset(await me(), id),
    sources: async () => { await ready; return svc.listSources(); },
    saveSource: async s => svc.saveSource(await me(), s),
    deleteSource: async id => svc.deleteSource(await me(), id),
    syncSource: async id => svc.requestSync(await me(), id),
    testSource: async id => svc.testSource(await me(), id),
    sampleUrl: () => null,
    runs: async status => svc.listRuns(await me(), { status: status as never }),
    inbox: async () => svc.inbox(await me()),
    run: async id => svc.getRun(await me(), id) as never,
    startAudits: async i => ({ runIds: await svc.startAudits(await me(), { ...i, layer2: 'heuristic' }) }),
    decide: async (id, action, reason) => {
      const a = await me(); const o = await svc.beginDecision(a, id, action, reason);
      await touch(a, `${action === 'approve' ? 'Approve' : 'Deny'} ${o.signing.module}`, `Your passkey signs this decision and report ${o.signing.reportHash.slice(0, 12)}…`);
      return svc.decide(a, id, action, reason, { challengeId: o.challengeId, response: await device(a.user.id).get(o.options) }) as never;
    },
    verify: async id => svc.verifyRun(await me(), id),
    diff: async id => svc.diff(await me(), id),
    reportUrl: () => null, evidenceUrl: () => null,
    evidence: async id => svc.evidencePackage(await me(), id),
    schedules: async () => { await ready; return (await svc.listSchedules()).map(s => ({ ...s, description: describeRecurrence(s.recurrence, s.timezone) })); },
    saveSchedule: async s => svc.saveSchedule(await me(), { ...s, layer2: 'heuristic' }),
    deleteSchedule: async id => svc.deleteSchedule(await me(), id),
    runSchedule: async id => ({ runIds: await svc.runScheduleNow(await me(), id) }),
    policies: async () => { await ready; return svc.listPolicies(); },
    savePolicy: async p => svc.savePolicy(await me(), p as never),
    deletePolicy: async id => svc.deletePolicy(await me(), id),
    simulate: async f => { await ready; return svc.simulatePolicy(f); },
    delegations: async () => svc.listDelegations(await me()),
    createDelegation: async d => svc.createDelegation(await me(), d),
    revokeDelegation: async id => svc.revokeDelegation(await me(), id),
    users: async () => svc.listUsers(await me()),
    createUser: async i => svc.createUser(await me(), i),
    updateUser: async (id, p) => svc.updateUser(await me(), id, p),
    groups: async () => { await ready; return svc.listGroups(); },
    saveGroup: async (g, m) => { await svc.saveGroup(await me(), g, m); },
    deleteGroup: async id => svc.deleteGroup(await me(), id),
    roles: async () => { await ready; return { roles: await svc.listRoles(), permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ id: id as never, label })) }; },
    saveRole: async r => svc.saveRole(await me(), r),
    deleteRole: async id => svc.deleteRole(await me(), id),
    tokens: async () => svc.listTokens(await me()),
    createToken: async i => svc.createToken(await me(), i),
    revokeToken: async id => svc.revokeToken(await me(), id),
    settings: async () => { await ready; return svc.getSettings(); },
    saveSettings: async s => svc.saveSettings(await me(), s),
    program: async ds => svc.programOverview(await me(), ds),
    chaosDrill: async (module, preset, datasetId) => svc.chaosDrill(await me(), { module, preset, datasetId }),
    ask: async (q, runId) => svc.ask(await me(), q, { runId, timezone: tz }),
    suggestions: async () => svc.automationSuggestions(await me(), tz),
    dismissSuggestion: async key => svc.dismissSuggestion(await me(), key),
    auditLog: async (l, b) => svc.auditLog(await me(), l, b),
    verifyAuditLog: async () => svc.verifyAuditLog(await me()),
  };
}
