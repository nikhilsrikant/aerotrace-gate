// Application services. Every rule about who may do what lives here, behind the Repo interface,
// so the Postgres server, the workers and the in-browser demo enforce exactly the same thing.
import type { Repo } from './repo';
import type {
  Actor, Permission, PublicUser, User, Group, Role, ApprovalPolicy, PolicyStep, Delegation, ApiToken, Settings, Dataset,
  RunRecord, DecisionRecord, Schedule, AuditEvent, RunProgress, Recurrence,
  Session, Passkey, PasskeyChallenge, PasskeyPolicy, PasskeyProof, ChallengePurpose, StepUpAction, Invite, Workspace, EvidenceSource, Provenance,
} from './model';
import { importBundle } from './bundle';
import { ALL_PERMISSIONS, DEFAULT_SETTINGS, DEFAULT_PASSKEY_POLICY, STEP_UP_ACTIONS, DEFAULT_WORKSPACE, wsOf } from './model';
import { scopedRepo } from './scopedRepo';
import { evaluateApproval, selectPolicy, stepFor, type ApprovalState, type Directory } from './policy';
import { nextRun, validateRecurrence, describeRecurrence } from './schedule';
import type { Signer } from './signer';
import { verifyAuditChain } from './auditHash';
import { runAudit, verifyChain, reportHashFor, canonical, sha256, randomId, generateCorpus, summarize } from '../engine';
import type { AuditOptions, Corpus, LLMClient, Fault, AgentName, DAL, Verdict } from '../engine';
import { AGENTS } from '../engine/types';
import { answerRules, answerLLM, type Answer, type AssistantData } from './assistant';
import { registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication, type RelyingParty, type RegistrationResponseJSON, type AuthenticationResponseJSON } from './webauthn';
import { decisionChallenge, verifyPasskeyProof, b64u } from './passkeyProof';
import { buildProgramOverview, type ProgramOverview } from './program';
import { telemetry } from '../engine/telemetry';
import { CHAOS_PRESETS, type ChaosPreset } from './chaos';
export { CHAOS_PRESETS, type ChaosPreset };
import type { AuditRun } from '../engine/types';

export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
const bad = (m: string) => new HttpError(400, m);
const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
const notFound = (what: string) => new HttpError(404, `${what} not found.`);

export interface Hasher { hash(pw: string): Promise<string>; verify(pw: string, h: string): Promise<boolean> }
export interface Deps {
  repo: Repo; signer: Signer; hasher: Hasher;
  llm?: (s: Settings) => Promise<LLMClient | null>;
  notify?: (s: Settings, event: string, payload: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
  inline?: boolean;          // run audits immediately instead of queueing (tests, browser demo)
  pace?: number;             // slow the broker down so the demo trail is watchable
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** Where passkeys are valid (domain and exact origins). */
  rp?: (s: Settings) => RelyingParty;
  /** Set on a workspace's services (see forWorkspace); repo is then that workspace's scoped view and baseRepo the whole store. */
  workspaceId?: string; baseRepo?: Repo;
  /** Evidence connectors (server only): build a bundle from Git, Jira and CI, and check a source's URLs and secret references. */
  sources?: {
    sync(src: EvidenceSource): Promise<{ bundle: Uint8Array; provenance: Omit<Provenance, 'sourceId' | 'sourceName' | 'fetchedAt'>; warnings: string[] }>;
    check(src: EvidenceSource): string[];
  };
}

export const strip = (u: User): PublicUser => { const { passwordHash: _ph, ...rest } = u; void _ph; return rest; };
const iso = (d: Date) => d.toISOString();

export interface ApprovalView {
  status: ApprovalState['status']; waitingOn: string; policyName: string | null; policyId: string | null; policyVersion: number | null;
  sequential: boolean; denyRequiresReason: boolean;
  steps: { id: string; name: string; min: number; satisfied: boolean; open: boolean; approvals: { by: string; at: string; onBehalfOf?: string | null }[]; eligible: { name: string; via: string }[] }[];
  canAct: boolean; actReason?: string; myStep?: string; onBehalfOf?: string | null;
}
export type RunView = Omit<RunRecord, 'result' | 'progress'> & { approval: ApprovalView };

export interface SyncResult { status: 'ok' | 'unchanged'; datasetId: string; commit: string; runIds: string[]; warnings: string[] }

export class Services {
  private corpusCache = new Map<string, Corpus>();
  constructor(public d: Deps) {}
  private wsCache = new Map<string, Services>();
  /** Services for one workspace: same rules, but every read and write goes through that workspace's scoped store. */
  forWorkspace(ws: string): Services {
    if (this.d.workspaceId) return this.d.workspaceId === ws ? this : (this.root ?? this).forWorkspace(ws);
    let s = this.wsCache.get(ws);
    if (!s) { s = new Services({ ...this.d, repo: scopedRepo(this.d.repo, ws), baseRepo: this.d.repo, workspaceId: ws }); s.root = this; this.wsCache.set(ws, s); }
    return s;
  }
  private root: Services | null = null;
  private get base(): Repo { return this.d.baseRepo ?? this.d.repo; }
  get workspaceId() { return this.d.workspaceId ?? DEFAULT_WORKSPACE; }

  // ---------- workspaces ----------
  /** Workspaces a person belongs to (roles there, or a group there). Platform administrators see all. */
  async workspacesFor(u: User | PublicUser): Promise<Workspace[]> {
    const all = (await this.base.listWorkspaces()).filter(w => !w.archived);
    if (u.platformAdmin) return all;
    const raw = await this.base.getUser(u.id); if (!raw) return [];
    const groups = await this.base.listGroups();
    const ids = new Set<string>([...Object.entries(raw.workspaceRoles ?? {}).filter(([, r]) => r.length).map(([w]) => w), ...groups.filter(g => raw.groupIds.includes(g.id)).map(g => wsOf(g))]);
    if (!raw.workspaceRoles && raw.roleIds.length) ids.add(DEFAULT_WORKSPACE);
    return all.filter(w => ids.has(w.id));
  }
  async createWorkspace(a: Actor, i: { name: string }) {
    if (!a.platformAdmin) throw forbidden('Only platform administrators can create workspaces.');
    const name = String(i.name || '').trim(); if (!name) throw bad('Name the workspace, for example the program it holds.');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
    if ((await this.base.listWorkspaces()).some(w => w.slug === slug)) throw bad(`A workspace called "${slug}" already exists.`);
    const w: Workspace = { id: randomId('ws'), name, slug, createdAt: iso(this.now()), createdBy: a.user.id };
    await this.base.createWorkspace(w);
    // Start it usable: the creator administers it, a Reviewers group, and a one-step policy that group signs.
    const svc = this.forWorkspace(w.id); const repo = svc.d.repo;
    await repo.updateUser(a.user.id, { roleIds: ['role_admin'] });
    const grp: Group = { id: randomId('grp'), name: 'Reviewers', description: 'People who can sign audits in this workspace', roleIds: ['role_auditor'], createdAt: iso(this.now()) };
    await repo.createGroup(grp);
    await repo.createPolicy({ id: randomId('pol'), name: 'Default: one reviewer', description: 'Any audit in this workspace needs one reviewer.', priority: 0, active: true,
      match: { datasetIds: [], modules: [], dals: [], verdicts: [] }, steps: [{ id: randomId('step'), name: 'Review', groupIds: [grp.id], userIds: [], min: 1 }],
      sequential: true, allowSelfApproval: false, denyRequiresReason: true, version: 1, updatedAt: iso(this.now()), updatedBy: a.user.name });
    await repo.putSettings({ ...(await this.base.getSettings('app')), orgName: name });
    await svc.audit(a, 'workspace.create', w.id, { name, slug });
    return w;
  }
  async renameWorkspace(a: Actor, id: string, name: string) {
    if (!a.platformAdmin) throw forbidden('Only platform administrators can rename workspaces.');
    if (!name?.trim()) throw bad('Give it a name.');
    await this.base.updateWorkspace(id, { name: name.trim() }); await this.forWorkspace(id).audit(a, 'workspace.rename', id, { name: name.trim() });
  }
  /** Point a browser session at another workspace the person belongs to. */
  async switchWorkspace(a: Actor, id: string) {
    const sess = this.requireSession(a);
    if (!(await this.workspacesFor(a.user)).some(w => w.id === id)) throw forbidden('You are not a member of that workspace.');
    await this.base.updateSession(sess.id, { workspaceId: id });
    await this.forWorkspace(id).audit(a, 'workspace.switch', id);
  }

  private get repo() { return this.d.repo; }
  private now() { return this.d.now ? this.d.now() : new Date(); }
  private log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) { this.d.log?.(level, msg, extra); }

  // ---------- identity ----------
  async actorFor(u: User | PublicUser, via: Actor['via'] = 'session'): Promise<Actor> {
    // Always use this workspace's view of the person: their roles and groups here, whatever object the caller passed.
    if (this.d.workspaceId) { const v = await this.repo.getUser(u.id); if (v) u = { ...v, platformAdmin: v.platformAdmin }; }
    const [roles, groups] = await Promise.all([this.repo.listRoles(), this.repo.listGroups()]);
    const roleIds = new Set(u.roleIds); groups.filter(g => u.groupIds.includes(g.id)).forEach(g => g.roleIds.forEach(r => roleIds.add(r)));
    const permissions = new Set<Permission>(); roles.filter(r => roleIds.has(r.id)).forEach(r => r.permissions.forEach(p => permissions.add(p)));
    if (u.platformAdmin) ALL_PERMISSIONS.forEach(p => permissions.add(p));
    return { user: 'passwordHash' in u ? strip(u as User) : u, permissions, via, workspaceId: this.workspaceId, platformAdmin: !!u.platformAdmin };
  }
  can(a: Actor, p: Permission) { return a.permissions.has(p); }
  need(a: Actor, p: Permission) { if (!a.permissions.has(p)) throw forbidden(); }
  async audit(a: Actor | null, action: string, target: string, details: Record<string, unknown> = {}) {
    return this.repo.appendAudit({ actorId: a?.user.id ?? 'system', actorName: a?.user.name ?? 'System', action, target, details });
  }

  async loginLocal(email: string, password: string, ip = 'unknown'): Promise<User> {
    const key = `${email.toLowerCase()}|${ip}`;
    const since = new Date(this.now().getTime() - 15 * 60000).toISOString();
    if ((await this.repo.countRecentFailures(key, since)) >= 5) throw new HttpError(429, 'Too many failed sign-ins. Wait 15 minutes and try again.');
    const u = await this.repo.getUserByEmail(email);
    const ok = !!u && u.active && u.provider === 'local' && !!u.passwordHash && (await this.d.hasher.verify(password, u.passwordHash));
    await this.repo.recordLoginAttempt(key, ok);
    if (!ok) { await this.audit(null, 'auth.login_failed', email.toLowerCase(), { ip }); throw new HttpError(401, 'Email or password is wrong, or the account is disabled.'); }
    await this.repo.updateUser(u!.id, { lastLoginAt: iso(this.now()) });
    await this.audit(await this.actorFor(u!), 'auth.login', u!.id, { ip, method: 'password' });
    return u!;
  }

  /** SSO users are created on first sign-in; their groups follow the identity provider's group claim. */
  async upsertSsoUser(email: string, name: string, idpGroups: string[]): Promise<User> {
    const groups = await this.repo.listGroups();
    const mapped = groups.filter(g => g.oidcName && idpGroups.includes(g.oidcName)).map(g => g.id);
    let u = await this.repo.getUserByEmail(email);
    if (!u) {
      const engineer = (await this.repo.listRoles()).find(r => r.name === 'Engineer');
      u = { id: randomId('usr'), email: email.toLowerCase(), name, active: true, provider: 'oidc', passwordHash: null, roleIds: engineer ? [engineer.id] : [], groupIds: mapped, createdAt: iso(this.now()) };
      await this.repo.createUser(u); await this.audit(null, 'user.create', u.id, { email, via: 'sso', groups: mapped });
    } else {
      if (!u.active) throw new HttpError(403, 'Your account is disabled. Ask an administrator.');
      const manual = u.groupIds.filter(id => !groups.find(g => g.id === id)?.oidcName);
      const next = [...new Set([...manual, ...mapped])];
      await this.repo.updateUser(u.id, { name, groupIds: next, lastLoginAt: iso(this.now()) }); u = { ...u, name, groupIds: next };
    }
    await this.audit(await this.actorFor(u), 'auth.login', u.id, { method: 'sso' });
    return u;
  }

  async changePassword(a: Actor, current: string, next: string) {
    const u = await this.repo.getUser(a.user.id); if (!u || u.provider !== 'local') throw bad('Only local accounts have a password here.');
    if (!u.passwordHash || !(await this.d.hasher.verify(current, u.passwordHash))) throw new HttpError(401, 'Current password is wrong.');
    checkPassword(next);
    await this.repo.updateUser(u.id, { passwordHash: await this.d.hasher.hash(next), mustChangePassword: false });
    await this.audit(a, 'user.password_changed', u.id);
  }

  // ---------- passkeys ----------
  // Rules in one place:
  //  * A browser session sees no audit data until the person has verified with a passkey in that session (policy.required).
  //  * Sensitive actions need a passkey check within policy.stepUpMinutes.
  //  * Approve and Deny are each signed by the approver's passkey over the exact report hash (policy.signDecisions).
  //  * API tokens never pass a passkey check, so they can't do any of the above.
  //  * Actors built in-process (scheduler, CLI, tests) carry no session and are trusted callers.
  async passkeyPolicy(): Promise<PasskeyPolicy> { return this.cleanPasskeyPolicy((await this.getSettings()).passkeys); }
  cleanPasskeyPolicy(p?: Partial<PasskeyPolicy>): PasskeyPolicy {
    const d = DEFAULT_PASSKEY_POLICY;
    const mins = Math.round(Number(p?.stepUpMinutes ?? d.stepUpMinutes));
    const aaguidOk = (x: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
    const allowed = (p?.allowedAuthenticators ?? d.allowedAuthenticators).map(a => ({ aaguid: String(a.aaguid ?? '').trim().toLowerCase(), name: String(a.name ?? '').trim().slice(0, 80) })).filter(a => a.aaguid);
    const bad = allowed.find(a => !aaguidOk(a.aaguid)); if (bad) throw new HttpError(400, `"${bad.aaguid}" is not an AAGUID (format 8-4-4-4-12 hex digits).`);
    const roots = (p?.attestationRoots ?? d.attestationRoots).map(x => String(x).trim()).filter(Boolean);
    if (roots.some(x => !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(x))) throw new HttpError(400, 'Attestation roots must be PEM certificates (-----BEGIN CERTIFICATE----- ...).');
    return { required: p?.required ?? d.required, signDecisions: p?.signDecisions ?? d.signDecisions,
      stepUpMinutes: Number.isFinite(mins) ? Math.min(Math.max(mins, 1), 240) : d.stepUpMinutes,
      stepUpFor: (p?.stepUpFor ?? d.stepUpFor).filter((x): x is StepUpAction => x in STEP_UP_ACTIONS),
      enrollment: (['invite', 'invite_or_sso', 'any'] as const).includes(p?.enrollment as never) ? p!.enrollment! : d.enrollment,
      allowedAuthenticators: allowed, attestationRoots: roots };
  }
  private rp(settings: Settings): RelyingParty {
    return this.d.rp ? this.d.rp(settings) : { id: 'localhost', name: settings.orgName, origins: ['http://localhost:3000'] };
  }
  /** What the UI needs to know about this person's passkey state. */
  async assurance(a: Actor) {
    const pol = await this.passkeyPolicy(); const keys = await this.repo.listPasskeys(a.user.id);
    const at = a.session?.passkeyAt ?? null;
    const until = at ? new Date(Date.parse(at) + pol.stepUpMinutes * 60e3).toISOString() : null;
    const u = await this.repo.getUser(a.user.id);
    const canEnroll = !!a.session && (keys.length > 0 ? true : this.firstEnrollAllowed(pol, a.session.method, u));
    return { canEnroll, enrollment: pol.enrollment, hardwareOnly: pol.allowedAuthenticators.length > 0, allowedAuthenticators: pol.allowedAuthenticators.map(x => x.name || x.aaguid),
      required: pol.required, verified: !!at, verifiedAt: at, stepUpUntil: until, stepUpMinutes: pol.stepUpMinutes, stepUpFor: pol.stepUpFor,
      signDecisions: pol.signDecisions, passkeys: keys.length, method: a.session?.method ?? (a.via === 'token' ? 'token' : null), passkeyId: a.session?.passkeyId ?? null };
  }
  /** The data gate. Call before serving anything except sign-in and passkey endpoints. */
  async assertAccess(a: Actor) {
    if (!a.session) return;
    if (a.session.passkeyAt) return;
    const pol = await this.passkeyPolicy(); if (!pol.required) return;
    const has = (await this.repo.listPasskeys(a.user.id)).length > 0;
    throw new HttpError(403, has ? 'Verify with your passkey to see audit data.' : 'Set up a passkey to see audit data.', has ? 'passkey_required' : 'passkey_enroll');
  }
  async stepUp(a: Actor, action: StepUpAction) {
    const pol = await this.passkeyPolicy(); if (!pol.stepUpFor.includes(action)) return;
    if (a.via === 'token') throw new HttpError(403, `"${STEP_UP_ACTIONS[action]}" needs a person to confirm with their passkey. API tokens can't do it.`, 'passkey_person_only');
    if (!a.session) return;
    if (!pol.required && !(await this.repo.listPasskeys(a.user.id)).length) return;
    const at = a.session.passkeyAt ? Date.parse(a.session.passkeyAt) : 0;
    if (this.now().getTime() - at > pol.stepUpMinutes * 60e3) throw new HttpError(403, 'Confirm it\'s you with your passkey to continue.', 'step_up_required');
  }
  private async newChallenge(purpose: ChallengePurpose, challenge: string, userId: string | null, sessionId: string | null, bind: PasskeyChallenge['bind'] = null) {
    const c: PasskeyChallenge = { id: randomId('chl'), purpose, challenge, userId, sessionId, bind, expiresAt: new Date(this.now().getTime() + 5 * 60e3).toISOString() };
    await this.repo.putChallenge(c); return c.id;
  }
  private async useChallenge(id: string, purpose: ChallengePurpose, a: Actor | null) {
    const c = id ? await this.repo.takeChallenge(String(id)) : null;
    if (!c || c.purpose !== purpose || Date.parse(c.expiresAt) < this.now().getTime()) throw new HttpError(400, 'That passkey request expired. Try again.', 'challenge_expired');
    if (a && (c.userId !== a.user.id || c.sessionId !== (a.session?.id ?? null))) throw new HttpError(400, 'That passkey request belongs to a different session.', 'challenge_mismatch');
    return c;
  }
  private async limitPasskeyFailures(key: string) {
    const since = new Date(this.now().getTime() - 15 * 60000).toISOString();
    if ((await this.repo.countRecentFailures(key, since)) >= 10) throw new HttpError(429, 'Too many failed passkey attempts. Wait 15 minutes.');
  }
  private requireSession(a: Actor) { if (!a.session) throw new HttpError(400, 'Passkeys are used from a signed-in browser session.'); return a.session; }

  /** Enrolment. The first passkey can be added right after a password or SSO sign-in; more need a fresh passkey check. */
  async beginPasskeyRegistration(a: Actor) {
    const sess = this.requireSession(a); const settings = await this.getSettings();
    const keys = await this.repo.listPasskeys(a.user.id);
    if (keys.length) {
      const pol = this.cleanPasskeyPolicy(settings.passkeys);
      if (!sess.passkeyAt || this.now().getTime() - Date.parse(sess.passkeyAt) > pol.stepUpMinutes * 60e3) throw new HttpError(403, 'Confirm with one of your existing passkeys before adding another.', 'step_up_required');
    }
    else if (!this.firstEnrollAllowed(this.cleanPasskeyPolicy(settings.passkeys), sess.method, await this.repo.getUser(a.user.id)))
      throw new HttpError(403, 'Your first passkey is set up from an invite link. Ask an administrator to send you one.', 'invite_required');
    if (keys.length >= 10) throw bad('You already have 10 passkeys. Remove one first.');
    const pol = this.cleanPasskeyPolicy(settings.passkeys);
    const options = await registrationOptions(this.rp(settings), a.user, keys, pol.allowedAuthenticators.length ? 'direct' : 'none');
    return { challengeId: await this.newChallenge('register', options.challenge, a.user.id, sess.id), options };
  }
  async finishPasskeyRegistration(a: Actor, challengeId: string, response: RegistrationResponseJSON, name?: string) {
    const sess = this.requireSession(a);
    const c = await this.useChallenge(challengeId, 'register', a);
    const settings = await this.getSettings();
    let v: Awaited<ReturnType<typeof verifyRegistration>>;
    const pol = this.cleanPasskeyPolicy(settings.passkeys);
    try { v = await verifyRegistration(this.rp(settings), response, c.challenge, pol.attestationRoots); }
    catch (e) { await this.audit(a, 'passkey.register_failed', a.user.id, { error: (e as Error).message }); throw bad(`The passkey was not accepted: ${(e as Error).message}`); }
    if (await this.repo.getPasskey(v.id)) throw bad('That passkey is already registered.');
    // Hardware allowlist: only trust the model ID when a vendor certificate proves it, chained to a root an admin pinned.
    let model: string | null = null;
    if (pol.allowedAuthenticators.length) {
      const refuse = async (why: string) => { await this.audit(a, 'passkey.register_refused', a.user.id, { why, aaguid: v.aaguid, fmt: v.fmt }); return new HttpError(400, why, 'authenticator_not_allowed'); };
      if (!pol.attestationRoots.length) throw await refuse('Only approved security keys can be enrolled, but no attestation root is configured, so no key can be proven genuine. An administrator needs to add the vendor\'s root certificate in Settings.');
      if (!v.fullAttestation) throw await refuse('This passkey did not prove its make and model. Use one of your organisation\'s approved security keys.');
      const hit = pol.allowedAuthenticators.find(x => x.aaguid === v.aaguid.toLowerCase());
      if (!hit) throw await refuse(`This authenticator model (${v.aaguid}) is not on your organisation's approved list.`);
      model = hit.name || hit.aaguid;
    }
    const count = (await this.repo.listPasskeys(a.user.id)).length;
    const { fmt: _f, fullAttestation, ...cred } = v; void _f;
    const pk: Passkey = { ...cred, userId: a.user.id, name: (name || '').trim().slice(0, 60) || model || `Passkey ${count + 1}`, createdAt: iso(this.now()), lastUsedAt: iso(this.now()), attested: !!model && fullAttestation, model };
    await this.repo.createPasskey(pk);
    if (count === 0) await this.repo.updateUser(a.user.id, { allowPasswordEnrollment: false });
    // Creating a passkey with user verification is itself a passkey check.
    const at = iso(this.now()); await this.repo.updateSession(sess.id, { passkeyAt: at, passkeyId: pk.id }); a.session = { ...sess, passkeyAt: at, passkeyId: pk.id };
    await this.audit(a, 'passkey.register', a.user.id, { passkey: pk.id.slice(0, 16), name: pk.name, deviceType: pk.deviceType, backedUp: pk.backedUp, aaguid: pk.aaguid, attested: pk.attested, model, via: sess.method });
    return this.publicPasskey(pk);
  }

  private firstEnrollAllowed(pol: PasskeyPolicy, method: Session['method'] | undefined, u: User | null) {
    if (pol.enrollment === 'any' || method === 'invite' || u?.allowPasswordEnrollment) return true;
    return pol.enrollment === 'invite_or_sso' && method === 'sso';
  }

  /** Invite link for a new person or someone whose passkeys were reset. One use, expires, replaces earlier unused links. */
  async createInvite(a: Actor, userId: string, hours = 72) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    const u = await this.repo.getUser(userId); if (!u || !u.active) throw bad('Invite an active user.');
    for (const i of await this.repo.listInvites(userId)) if (!i.usedAt && !i.revokedAt) await this.repo.updateInvite(i.id, { revokedAt: iso(this.now()) });
    const bytes = new Uint8Array(24); globalThis.crypto.getRandomValues(bytes);
    const token = 'ati_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const h = Math.min(Math.max(Math.round(Number(hours) || 72), 1), 24 * 14);
    const inv: Invite = { id: randomId('inv'), tokenHash: await sha256(token), userId, createdBy: a.user.id, createdAt: iso(this.now()), expiresAt: new Date(this.now().getTime() + h * 3600e3).toISOString() };
    await this.repo.createInvite(inv);
    await this.audit(a, 'user.invite', userId, { email: u.email, expiresAt: inv.expiresAt });
    return { token, expiresAt: inv.expiresAt, email: u.email, name: u.name };
  }
  async redeemInvite(token: string, ip = 'unknown'): Promise<User> {
    const since = new Date(this.now().getTime() - 15 * 60000).toISOString();
    if ((await this.repo.countRecentFailures(`invite|${ip}`, since)) >= 10) throw new HttpError(429, 'Too many invalid invite links. Wait 15 minutes.');
    const inv = token ? await this.repo.getInviteByHash(await sha256(String(token))) : null;
    const u = inv ? await this.repo.getUser(inv.userId) : null;
    if (!inv || inv.usedAt || inv.revokedAt || Date.parse(inv.expiresAt) < this.now().getTime() || !u || !u.active) {
      await this.repo.recordLoginAttempt(`invite|${ip}`, false); await this.audit(null, 'auth.invite_failed', inv?.userId ?? 'unknown', { ip, why: !inv ? 'unknown' : inv.usedAt ? 'already used' : inv.revokedAt ? 'replaced' : 'expired' });
      throw new HttpError(400, 'This invite link has expired or was already used. Ask your administrator for a new one.', 'invite_invalid');
    }
    await this.repo.updateInvite(inv.id, { usedAt: iso(this.now()) });
    await this.repo.updateUser(u.id, { lastLoginAt: iso(this.now()) });
    await this.audit(await this.actorFor(u), 'auth.invite_redeemed', u.id, { ip });
    return u;
  }

  /** Passwordless sign-in: the browser offers whichever passkey the person picks. */
  async beginPasskeyLogin() {
    const options = await authenticationOptions(this.rp(await this.getSettings()), null);
    return { challengeId: await this.newChallenge('login', options.challenge, null, null), options };
  }
  async finishPasskeyLogin(challengeId: string, response: AuthenticationResponseJSON, ip = 'unknown'): Promise<{ user: User; passkeyId: string }> {
    await this.limitPasskeyFailures(`passkey|${ip}`);
    const c = await this.useChallenge(challengeId, 'login', null);
    const pk = await this.repo.getPasskey(String(response?.id || ''));
    const fail = async (why: string) => { telemetry.count('aerotrace.passkey.failures', 1, { kind: 'login' }); await this.repo.recordLoginAttempt(`passkey|${ip}`, false); await this.audit(null, 'auth.login_failed', pk?.userId ?? 'unknown', { ip, method: 'passkey', why }); return new HttpError(401, 'That passkey was not accepted.'); };
    if (!pk) throw await fail('unknown passkey');
    const u = await this.repo.getUser(pk.userId); if (!u || !u.active) throw await fail('account disabled');
    if (response.response?.userHandle && new TextDecoder().decode(b64u.decode(response.response.userHandle)) !== u.id) throw await fail('user handle mismatch');
    try { const v = await verifyAuthentication(this.rp(await this.getSettings()), response, c.challenge, pk); await this.repo.updatePasskey(pk.id, { counter: v.newCounter, lastUsedAt: iso(this.now()) }); }
    catch (e) { throw await fail((e as Error).message); }
    await this.repo.recordLoginAttempt(`passkey|${ip}`, true);
    await this.repo.updateUser(u.id, { lastLoginAt: iso(this.now()) });
    await this.audit(await this.actorFor(u), 'auth.login', u.id, { ip, method: 'passkey', passkey: pk.id.slice(0, 16) });
    return { user: u, passkeyId: pk.id };
  }

  /** Unlock or re-confirm the current session with one of this person's passkeys. */
  async beginPasskeyVerify(a: Actor) {
    const sess = this.requireSession(a);
    const keys = await this.repo.listPasskeys(a.user.id); if (!keys.length) throw new HttpError(403, 'You have no passkey yet. Set one up first.', 'passkey_enroll');
    const options = await authenticationOptions(this.rp(await this.getSettings()), keys);
    return { challengeId: await this.newChallenge('verify', options.challenge, a.user.id, sess.id), options };
  }
  async finishPasskeyVerify(a: Actor, challengeId: string, response: AuthenticationResponseJSON) {
    const sess = this.requireSession(a);
    await this.limitPasskeyFailures(`passkey|${a.user.id}`);
    const c = await this.useChallenge(challengeId, 'verify', a);
    const pk = await this.ownPasskey(a, response);
    try { const v = await verifyAuthentication(this.rp(await this.getSettings()), response, c.challenge, pk); await this.repo.updatePasskey(pk.id, { counter: v.newCounter, lastUsedAt: iso(this.now()) }); }
    catch (e) { telemetry.count('aerotrace.passkey.failures', 1, { kind: 'verify' }); await this.repo.recordLoginAttempt(`passkey|${a.user.id}`, false); await this.audit(a, 'auth.passkey_failed', a.user.id, { why: (e as Error).message }); throw new HttpError(401, 'That passkey was not accepted.'); }
    const at = iso(this.now()); await this.repo.updateSession(sess.id, { passkeyAt: at, passkeyId: pk.id }); a.session = { ...sess, passkeyAt: at, passkeyId: pk.id };
    await this.audit(a, 'auth.passkey_verified', a.user.id, { passkey: pk.id.slice(0, 16) });
    return { verifiedAt: at };
  }
  private async ownPasskey(a: Actor, response: AuthenticationResponseJSON) {
    const pk = await this.repo.getPasskey(String(response?.id || ''));
    if (!pk || pk.userId !== a.user.id) { await this.repo.recordLoginAttempt(`passkey|${a.user.id}`, false); throw new HttpError(401, 'That passkey is not registered to you.'); }
    return pk;
  }

  /** Step 1 of approving or denying: a challenge derived from the exact decision, for the approver's device to sign. */
  async beginDecision(a: Actor, runId: string, action: 'approve' | 'deny', reason?: string) {
    const sess = this.requireSession(a);
    if (action !== 'approve' && action !== 'deny') throw bad('Action must be approve or deny.');
    const run = await this.repo.getRun(runId); if (!run) throw notFound('Audit');
    if (run.status !== 'awaiting_approval' || !run.reportHash) throw new HttpError(409, 'This audit is not waiting for a decision.');
    const pick = stepFor(evaluateApproval(await this.policyFor(run), run, await this.directory(), this.now()), a.user.id);
    if ('reason' in pick) throw forbidden(pick.reason);
    const keys = await this.repo.listPasskeys(a.user.id); if (!keys.length) throw new HttpError(403, 'Set up a passkey first. Decisions are signed with it.', 'passkey_enroll');
    const bind = { runId, action, reportHash: run.reportHash, reason: reason?.trim() || null };
    const nonce = randomId('n');
    const challenge = await decisionChallenge({ run: runId, action, reportHash: run.reportHash, reason: bind.reason, by: a.user.id, nonce });
    const options = await authenticationOptions(this.rp(await this.getSettings()), keys, b64u.decode(challenge));
    const challengeId = await this.newChallenge('decision', options.challenge, a.user.id, sess.id, { ...bind, nonce });
    return { challengeId, options, signing: { module: run.module, reportHash: run.reportHash, action } };
  }
  private async decisionProof(a: Actor, runId: string, action: 'approve' | 'deny', reason: string | null, proof?: { challengeId: string; response: AuthenticationResponseJSON }) {
    const pol = await this.passkeyPolicy();
    if (a.via === 'token' && pol.signDecisions) throw new HttpError(403, 'Approvals and denials need a person and their passkey. API tokens cannot sign them.', 'passkey_person_only');
    if (!a.session || !pol.signDecisions) return null;
    if (!proof?.challengeId || !proof.response) throw new HttpError(403, 'Confirm this decision with your passkey.', 'decision_passkey_required');
    await this.limitPasskeyFailures(`passkey|${a.user.id}`);
    const c = await this.useChallenge(proof.challengeId, 'decision', a);
    const b = c.bind ?? null;
    if (!b || b.runId !== runId || b.action !== action || (b.reason ?? null) !== (reason ?? null)) throw new HttpError(400, 'The passkey confirmed a different decision. Try again.', 'challenge_mismatch');
    const pk = await this.ownPasskey(a, proof.response);
    const rp = this.rp(await this.getSettings());
    let v: Awaited<ReturnType<typeof verifyAuthentication>>;
    try { v = await verifyAuthentication(rp, proof.response, c.challenge, pk); }
    catch (e) { telemetry.count('aerotrace.passkey.failures', 1, { kind: 'verify' }); await this.repo.recordLoginAttempt(`passkey|${a.user.id}`, false); await this.audit(a, 'auth.passkey_failed', runId, { why: (e as Error).message }); throw new HttpError(401, 'That passkey was not accepted.'); }
    await this.repo.updatePasskey(pk.id, { counter: v.newCounter, lastUsedAt: iso(this.now()) });
    const at = iso(this.now()); await this.repo.updateSession(a.session.id, { passkeyAt: at, passkeyId: pk.id });
    const r = proof.response.response;
    return { reportHash: b.reportHash, proof: { credentialId: pk.id, publicKey: pk.publicKey, challenge: c.challenge, rpId: v.rpId, origin: v.origin, nonce: b.nonce,
      authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature, userVerified: v.userVerified, verifiedAt: at } satisfies PasskeyProof };
  }

  // passkey management
  publicPasskey(p: Passkey) { const { publicKey: _k, counter: _c, ...rest } = p; void _k; void _c; return rest; }
  async myPasskeys(a: Actor) { return (await this.repo.listPasskeys(a.user.id)).map(p => this.publicPasskey(p)); }
  async renamePasskey(a: Actor, id: string, name: string) {
    const pk = await this.repo.getPasskey(id); if (!pk || pk.userId !== a.user.id) throw notFound('Passkey');
    if (!name?.trim()) throw bad('Give the passkey a name, for example "Work laptop".');
    await this.repo.updatePasskey(id, { name: name.trim().slice(0, 60) }); await this.audit(a, 'passkey.rename', a.user.id, { passkey: id.slice(0, 16), name: name.trim() });
  }
  async removePasskey(a: Actor, id: string) {
    const pk = await this.repo.getPasskey(id); if (!pk || pk.userId !== a.user.id) throw notFound('Passkey');
    const sess = this.requireSession(a); const pol = await this.passkeyPolicy();
    if (!sess.passkeyAt || this.now().getTime() - Date.parse(sess.passkeyAt) > pol.stepUpMinutes * 60e3) throw new HttpError(403, 'Confirm with your passkey before removing one.', 'step_up_required');
    const all = await this.repo.listPasskeys(a.user.id);
    if (pol.required && all.length <= 1) throw bad('This is your only passkey and passkeys are required. Add another one before removing it.');
    await this.repo.deletePasskey(id); await this.audit(a, 'passkey.remove', a.user.id, { passkey: id.slice(0, 16), name: pk.name });
  }
  /** Lost or replaced device: an administrator clears someone's passkeys and signs them out everywhere. */
  async resetPasskeys(a: Actor, userId: string) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    if (userId === a.user.id) throw bad('Manage your own passkeys on the Security page.');
    const u = await this.repo.getUser(userId); if (!u) throw notFound('User');
    const keys = await this.repo.listPasskeys(userId);
    for (const k of keys) await this.repo.deletePasskey(k.id);
    await this.repo.deleteUserSessions(userId);
    await this.audit(a, 'passkey.reset', userId, { removed: keys.length, user: u.email });
    const inv = await this.createInvite(a, userId);
    return { removed: keys.length, invite: inv };
  }
  async passkeyCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}; for (const p of await this.repo.listPasskeys()) out[p.userId] = (out[p.userId] ?? 0) + 1; return out;
  }
  /** Actor for a browser session, carrying the passkey state of that session. */
  async actorForSession(s: Session): Promise<Actor | null> {
    const u = await this.repo.getUser(s.userId); if (!u || !u.active) return null;
    const a = await this.actorFor(u, 'session');
    a.session = { id: s.id, method: s.method ?? 'password', passkeyAt: s.passkeyAt ?? null, passkeyId: s.passkeyId ?? null };
    return a;
  }

  // ---------- directory admin ----------
  async listUsers(a: Actor): Promise<(PublicUser & { passkeys?: number })[]> {
    if (!this.can(a, 'access.manage') && !this.can(a, 'policy.manage') && !this.can(a, 'delegation.manage')) return [a.user];
    const counts = this.can(a, 'access.manage') ? await this.passkeyCounts() : null;
    return (await this.repo.listUsers()).map(u => ({ ...strip(u), ...(counts ? { passkeys: counts[u.id] ?? 0 } : {}) }));
  }
  async directoryNames() { return (await this.repo.listUsers()).filter(u => u.active).map(u => ({ id: u.id, name: u.name, email: u.email })); }
  async createUser(a: Actor, i: { email: string; name: string; password?: string; roleIds?: string[]; groupIds?: string[] }) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    const email = (i.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('Enter a valid email address.');
    if (!i.name?.trim()) throw bad('Enter a name.');
    const existing = this.d.workspaceId ? await this.repo.getUserByEmail(email) : null;
    if (existing) {
      // Same person, another program: add them to this workspace instead of creating a second account.
      if (existing.roleIds.length || existing.groupIds.length) throw bad(`${existing.name} is already in this workspace.`);
      await this.repo.updateUser(existing.id, { roleIds: i.roleIds ?? [], groupIds: i.groupIds ?? [] });
      await this.audit(a, 'user.added_to_workspace', existing.id, { email, roleIds: i.roleIds ?? [], groupIds: i.groupIds ?? [] });
      return strip({ ...existing, roleIds: i.roleIds ?? [], groupIds: i.groupIds ?? [] });
    }
    if (i.password) checkPassword(i.password);
    const u: User = { id: randomId('usr'), email, name: i.name.trim(), active: true, provider: 'local', passwordHash: i.password ? await this.d.hasher.hash(i.password) : null,
      roleIds: i.roleIds ?? [], groupIds: i.groupIds ?? [], createdAt: iso(this.now()), mustChangePassword: !!i.password };
    await this.repo.createUser(u); await this.audit(a, 'user.create', u.id, { email, roleIds: u.roleIds, groupIds: u.groupIds });
    return strip(u);
  }
  async updateUser(a: Actor, id: string, p: { name?: string; active?: boolean; roleIds?: string[]; groupIds?: string[]; password?: string }) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    const u = await this.repo.getUser(id); if (!u) throw notFound('User');
    if (p.active === false && id === a.user.id) throw bad('You cannot disable your own account.');
    const patch: Partial<User> = {};
    if (p.name !== undefined) patch.name = p.name.trim();
    if (p.active !== undefined) patch.active = p.active;
    if (p.roleIds) patch.roleIds = p.roleIds;
    if (p.groupIds) patch.groupIds = p.groupIds;
    if (p.password) { checkPassword(p.password); patch.passwordHash = await this.d.hasher.hash(p.password); patch.mustChangePassword = true; }
    await this.repo.updateUser(id, patch);
    try { await this.ensureAnAdmin(); } catch (e) { await this.repo.updateUser(id, { name: u.name, active: u.active, roleIds: u.roleIds, groupIds: u.groupIds, passwordHash: u.passwordHash, mustChangePassword: u.mustChangePassword }); throw e; }
    if (p.active === false || p.password) await this.repo.deleteUserSessions(id);
    await this.audit(a, 'user.update', id, { ...patch, passwordHash: patch.passwordHash ? '[changed]' : undefined });
  }
  private async ensureAnAdmin() {
    const [users, roles, groups] = await Promise.all([this.repo.listUsers(), this.repo.listRoles(), this.repo.listGroups()]);
    const adminRoles = new Set(roles.filter(r => r.permissions.includes('access.manage')).map(r => r.id));
    const ok = users.some(u => u.active && (u.platformAdmin || u.roleIds.some(r => adminRoles.has(r)) || groups.some(g => u.groupIds.includes(g.id) && g.roleIds.some(r => adminRoles.has(r)))));
    if (!ok) throw bad('That change would leave nobody able to manage access. Keep at least one active administrator.');
  }
  private async restore(b: { groups: Group[]; users: User[] }) {
    const now = await this.repo.listGroups();
    for (const g of now) if (!b.groups.find(x => x.id === g.id)) await this.repo.deleteGroup(g.id);
    for (const g of b.groups) { if (now.find(x => x.id === g.id)) await this.repo.updateGroup(g.id, g); else await this.repo.createGroup(g); }
    for (const u of b.users) await this.repo.updateUser(u.id, { groupIds: u.groupIds, roleIds: u.roleIds });
  }
  async listGroups() { return this.repo.listGroups(); }
  async saveGroup(a: Actor, g: Partial<Group> & { name: string }, memberIds?: string[]) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    if (!g.name?.trim()) throw bad('Give the group a name.');
    const before = { groups: await this.repo.listGroups(), users: await this.repo.listUsers() };
    let id = g.id;
    if (id) { await this.repo.updateGroup(id, { name: g.name.trim(), description: g.description ?? '', oidcName: g.oidcName || null, roleIds: g.roleIds ?? [] }); }
    else { id = randomId('grp'); await this.repo.createGroup({ id, name: g.name.trim(), description: g.description ?? '', oidcName: g.oidcName || null, roleIds: g.roleIds ?? [], createdAt: iso(this.now()) }); }
    if (memberIds) {
      for (const u of await this.repo.listUsers()) {
        const has = u.groupIds.includes(id), want = memberIds.includes(u.id);
        if (has !== want) await this.repo.updateUser(u.id, { groupIds: want ? [...u.groupIds, id] : u.groupIds.filter(x => x !== id) });
      }
    }
    try { await this.ensureAnAdmin(); } catch (e) { await this.restore(before); throw e; }
    await this.audit(a, g.id ? 'group.update' : 'group.create', id, { name: g.name, roleIds: g.roleIds, members: memberIds?.length });
    return id;
  }
  async deleteGroup(a: Actor, id: string) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    const used = (await this.repo.listPolicies()).filter(p => p.steps.some(s => s.groupIds.includes(id)));
    if (used.length) throw bad(`Policies still use this group: ${used.map(p => p.name).join(', ')}. Remove it from them first.`);
    const before = { groups: await this.repo.listGroups(), users: await this.repo.listUsers() };
    await this.repo.deleteGroup(id);
    try { await this.ensureAnAdmin(); } catch (e) { await this.restore(before); throw e; }
    await this.audit(a, 'group.delete', id);
  }
  async listRoles() { return this.repo.listRoles(); }
  async saveRole(a: Actor, r: Partial<Role> & { name: string; permissions: Permission[] }) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    const perms = r.permissions.filter(p => ALL_PERMISSIONS.includes(p));
    let prevPerms: Permission[] | null = null;
    if (r.id) {
      const cur = (await this.repo.listRoles()).find(x => x.id === r.id); if (!cur) throw notFound('Role'); prevPerms = cur.permissions;
      if (cur.builtIn && cur.name === 'Administrator' && perms.length !== ALL_PERMISSIONS.length) throw bad('The Administrator role always has every permission.');
      await this.repo.updateRole(r.id, { name: r.name, description: r.description ?? '', permissions: perms });
    } else await this.repo.createRole({ id: randomId('role'), name: r.name, description: r.description ?? '', permissions: perms, builtIn: false, createdAt: iso(this.now()) });
    if (r.id) { try { await this.ensureAnAdmin(); } catch (e) { const cur = (await this.repo.listRoles()).find(x => x.id === r.id)!; void cur; await this.repo.updateRole(r.id, { permissions: prevPerms! }); throw e; } } await this.audit(a, r.id ? 'role.update' : 'role.create', r.id ?? r.name, { permissions: perms });
  }
  async deleteRole(a: Actor, id: string) {
    this.need(a, 'access.manage'); await this.stepUp(a, 'access.change');
    const r = (await this.repo.listRoles()).find(x => x.id === id); if (!r) throw notFound('Role'); if (r.builtIn) throw bad('Built-in roles can be edited but not deleted.');
    const users = await this.repo.listUsers(), groups = await this.repo.listGroups();
    const holders = users.filter(u => u.roleIds.includes(id)).length + groups.filter(g => g.roleIds.includes(id)).length;
    if (holders && r.permissions.includes('access.manage')) { await this.repo.deleteRole(id); try { await this.ensureAnAdmin(); } catch (e) { await this.repo.createRole(r); await this.restore({ users, groups }); throw e; } }
    else await this.repo.deleteRole(id);
    await this.audit(a, 'role.delete', id);
  }

  // ---------- approval policies ----------
  async listPolicies() { return (await this.repo.listPolicies()).sort((x, y) => y.priority - x.priority || x.name.localeCompare(y.name)); }
  async savePolicy(a: Actor, p: Omit<ApprovalPolicy, 'version' | 'updatedAt' | 'updatedBy'> & { id?: string }) {
    this.need(a, 'policy.manage'); await this.stepUp(a, 'policy.change');
    if (!p.name?.trim()) throw bad('Give the policy a name.');
    if (!p.steps?.length) throw bad('A policy needs at least one approval step.');
    const groups = new Set((await this.repo.listGroups()).map(g => g.id)), users = new Set((await this.repo.listUsers()).map(u => u.id));
    const steps: PolicyStep[] = p.steps.map((s, i) => {
      if (!s.name?.trim()) throw bad(`Step ${i + 1} needs a name.`);
      const g = (s.groupIds ?? []).filter(x => groups.has(x)), u = (s.userIds ?? []).filter(x => users.has(x));
      if (!g.length && !u.length) throw bad(`Step "${s.name}" has no approvers. Add a group or a person.`);
      const min = Math.floor(Number(s.min) || 1); if (min < 1 || min > 10) throw bad(`Step "${s.name}" must need between 1 and 10 approvals.`);
      return { id: s.id || randomId('step'), name: s.name.trim(), groupIds: g, userIds: u, min };
    });
    const match = { datasetIds: p.match?.datasetIds ?? [], modules: (p.match?.modules ?? []).map(m => m.trim()).filter(Boolean), dals: p.match?.dals ?? [], verdicts: p.match?.verdicts ?? [] };
    const prev = p.id ? (await this.repo.listPolicies()).find(x => x.id === p.id) : null;
    const pol: ApprovalPolicy = { id: p.id || randomId('pol'), name: p.name.trim(), description: p.description ?? '', priority: Math.round(Number(p.priority) || 0), active: p.active !== false,
      match, steps, sequential: !!p.sequential, allowSelfApproval: !!p.allowSelfApproval, denyRequiresReason: !!p.denyRequiresReason,
      version: (prev?.version ?? 0) + 1, updatedAt: iso(this.now()), updatedBy: a.user.name };
    if (prev) await this.repo.updatePolicy(pol.id, pol); else await this.repo.createPolicy(pol);
    await this.audit(a, prev ? 'policy.update' : 'policy.create', pol.id, { name: pol.name, version: pol.version, match, steps: steps.map(s => ({ name: s.name, min: s.min, groups: s.groupIds.length, users: s.userIds.length })) });
    return pol;
  }
  async deletePolicy(a: Actor, id: string) { this.need(a, 'policy.manage'); await this.stepUp(a, 'policy.change'); await this.repo.deletePolicy(id); await this.audit(a, 'policy.delete', id); }
  /** "Who could approve this?" without running anything. */
  async simulatePolicy(facts: { datasetId: string; module: string; dal: DAL; verdict: Verdict; requestedBy: string }) {
    const p = selectPolicy(await this.repo.listPolicies(), facts);
    const st = evaluateApproval(p ? { ...p, sequential: false } : null, { requestedBy: facts.requestedBy, decisions: [] }, await this.directory(), this.now());
    return { policy: p ? { id: p.id, name: p.name, version: p.version } : null, waitingOn: st.waitingOn,
      steps: st.steps.map(s => ({ name: s.step.name, min: s.step.min, eligible: s.eligible.map(e => `${e.name}${e.via === 'delegation' ? ' (delegate)' : ''}`) })),
      allSteps: (p?.steps ?? []).map(s => s.name) };
  }

  // ---------- delegations ----------
  async listDelegations(a: Actor) { const all = await this.repo.listDelegations(); return this.can(a, 'delegation.manage') ? all : all.filter(d => d.fromUserId === a.user.id || d.toUserId === a.user.id); }
  async createDelegation(a: Actor, i: { fromUserId?: string; toUserId: string; startsAt: string; endsAt: string; reason: string }) {
    const from = i.fromUserId || a.user.id;
    if (from !== a.user.id) this.need(a, 'delegation.manage');
    await this.stepUp(a, 'delegation.change');
    if (from === i.toUserId) throw bad('Pick someone other than the person delegating.');
    const to = await this.repo.getUser(i.toUserId); if (!to || !to.active) throw bad('The delegate must be an active user.');
    const s = Date.parse(i.startsAt), e = Date.parse(i.endsAt);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw bad('The end must be after the start.');
    if (e - s > 90 * 86400e3) throw bad('Delegations can last at most 90 days.');
    if (!i.reason?.trim()) throw bad('Say why, so the audit trail explains it (for example "Annual leave").');
    const d: Delegation = { id: randomId('del'), fromUserId: from, toUserId: i.toUserId, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), reason: i.reason.trim(), createdBy: a.user.id, createdAt: iso(this.now()) };
    await this.repo.createDelegation(d); await this.audit(a, 'delegation.create', d.id, { from, to: i.toUserId, startsAt: d.startsAt, endsAt: d.endsAt, reason: d.reason });
    return d;
  }
  async revokeDelegation(a: Actor, id: string) {
    const d = (await this.repo.listDelegations()).find(x => x.id === id); if (!d) throw notFound('Delegation');
    if (d.fromUserId !== a.user.id) this.need(a, 'delegation.manage');
    await this.repo.updateDelegation(id, { revokedAt: iso(this.now()) }); await this.audit(a, 'delegation.revoke', id);
  }

  // ---------- API tokens ----------
  async listTokens(a: Actor) { const t = await this.repo.listTokens(); return (this.can(a, 'access.manage') ? t : t.filter(x => x.userId === a.user.id)).map(({ tokenHash: _h, ...r }) => { void _h; return r; }); }
  async createToken(a: Actor, i: { name: string; userId?: string; expiresInDays?: number }) {
    const userId = i.userId || a.user.id; if (userId !== a.user.id) this.need(a, 'access.manage');
    await this.stepUp(a, 'token.create');
    if (!i.name?.trim()) throw bad('Name the token after what will use it, for example "Jenkins nightly".');
    const bytes = new Uint8Array(24); globalThis.crypto.getRandomValues(bytes);
    const secret = 'atg_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const days = Math.min(Math.max(Number(i.expiresInDays) || 90, 1), 365);
    const t: ApiToken = { id: randomId('tok'), name: i.name.trim(), userId, prefix: secret.slice(0, 10), tokenHash: await sha256(secret), createdAt: iso(this.now()), expiresAt: new Date(this.now().getTime() + days * 86400e3).toISOString() };
    await this.repo.createToken(t); await this.audit(a, 'token.create', t.id, { name: t.name, userId, expiresAt: t.expiresAt });
    return { token: secret, id: t.id, expiresAt: t.expiresAt! };
  }
  async revokeToken(a: Actor, id: string) {
    const t = (await this.repo.listTokens()).find(x => x.id === id); if (!t) throw notFound('Token');
    if (t.userId !== a.user.id) this.need(a, 'access.manage');
    await this.repo.updateToken(id, { revokedAt: iso(this.now()) }); await this.audit(a, 'token.revoke', id);
  }
  async actorFromToken(secret: string): Promise<Actor | null> {
    const t = await this.repo.getTokenByHash(await sha256(secret));
    if (!t || t.revokedAt || (t.expiresAt && Date.parse(t.expiresAt) < this.now().getTime())) return null;
    const u = await this.repo.getUser(t.userId); if (!u || !u.active) return null;
    await this.repo.updateToken(t.id, { lastUsedAt: iso(this.now()) });
    return this.actorFor(u, 'token');
  }

  // ---------- settings ----------
  async getSettings() { return { ...DEFAULT_SETTINGS, ...(await this.repo.getSettings()) }; }
  async saveSettings(a: Actor, s: Settings) {
    this.need(a, 'settings.manage'); await this.stepUp(a, 'settings.change');
    s = { ...s, passkeys: this.cleanPasskeyPolicy(s.passkeys) };
    const before = (await this.getSettings()).passkeys!;
    if (this.d.workspaceId && !a.platformAdmin && JSON.stringify(before) !== JSON.stringify(s.passkeys)) throw forbidden('The passkey policy covers every workspace, so only a platform administrator can change it.');
    if (!['none', 'anthropic', 'openai'].includes(s.llm.provider)) throw bad('Unknown LLM provider.');
    for (const u of [s.notifications.slackUrl, s.notifications.teamsUrl, s.notifications.webhookUrl]) if (u && !/^https:\/\//.test(u)) throw bad('Notification URLs must start with https://');
    await this.repo.putSettings(s);
    if (JSON.stringify(before) !== JSON.stringify(s.passkeys)) await this.audit(a, 'settings.passkey_policy', 'settings', { before, after: s.passkeys });
    await this.audit(a, 'settings.update', 'settings', { llm: s.llm, notifications: { ...s.notifications, slackUrl: !!s.notifications.slackUrl, teamsUrl: !!s.notifications.teamsUrl, webhookUrl: !!s.notifications.webhookUrl } });
  }

  // ---------- datasets ----------
  async listDatasets() { return this.repo.listDatasets(); }
  async corpusFor(d: Dataset): Promise<Corpus> {
    const hit = this.corpusCache.get(d.id); if (hit) return hit;
    let c: Corpus | null = null;
    if (d.source === 'synthetic') c = generateCorpus({ seed: d.seed ?? 178 });
    else c = await this.repo.getCorpus(d.id);
    if (!c) throw new HttpError(409, `Dataset "${d.name}" is not ready yet.`);
    if (this.corpusCache.size >= 4) this.corpusCache.delete(this.corpusCache.keys().next().value!);
    this.corpusCache.set(d.id, c); return c;
  }
  async createSyntheticDataset(a: Actor | null, name: string, seed = 178) {
    if (a) { this.need(a, 'dataset.manage'); await this.stepUp(a, 'dataset.change'); }
    const c = generateCorpus({ seed });
    const d: Dataset = { id: randomId('ds'), name, program: c.program, baseline: c.baseline, source: 'synthetic', status: 'ready', seed, total: c.total, counts: c.counts,
      modules: c.modules.map(m => ({ id: m.id, name: m.name, dal: m.dal })), warnings: [], createdBy: a?.user.name ?? 'System', createdAt: iso(this.now()) };
    await this.repo.createDataset(d); this.corpusCache.set(d.id, c);
    await this.audit(a, 'dataset.create', d.id, { name, source: 'synthetic', seed, total: c.total });
    return d;
  }
  async registerBundle(a: Actor, name: string, bytes: Uint8Array) {
    this.need(a, 'dataset.manage'); await this.stepUp(a, 'dataset.change');
    if (!name.trim()) throw bad('Name the dataset.');
    const d: Dataset = { id: randomId('ds'), name: name.trim(), program: '(importing)', baseline: '', source: 'bundle', status: 'importing', total: 0, counts: {}, modules: [], warnings: [], createdBy: a.user.name, createdAt: iso(this.now()) };
    await this.repo.createDataset(d, bytes);
    await this.repo.enqueue({ id: randomId('job'), kind: 'import', payload: { datasetId: d.id }, status: 'queued', attempts: 0, maxAttempts: 2, runAfter: iso(this.now()), createdAt: iso(this.now()) });
    await this.audit(a, 'dataset.upload', d.id, { name: d.name, bytes: bytes.byteLength, sha256: await sha256(Array.from(bytes.subarray(0, 4096)).join(',') + bytes.byteLength) });
    return d;
  }
  async completeImport(id: string, c: Corpus, warnings: string[]): Promise<void> {
    if (!this.d.workspaceId) { const d = await this.repo.getDataset(id); if (d?.workspaceId) return this.forWorkspace(d.workspaceId).completeImport(id, c, warnings); }
    await this.repo.putCorpus(id, c);
    await this.repo.updateDataset(id, { status: 'ready', program: c.program, baseline: c.baseline, total: c.total, counts: c.counts, modules: c.modules.map(m => ({ id: m.id, name: m.name, dal: m.dal })), warnings });
    this.corpusCache.delete(id);
    await this.audit(null, 'dataset.imported', id, { total: c.total, modules: c.modules.length, warnings: warnings.length });
  }
  async failImport(id: string, error: string): Promise<void> {
    if (!this.d.workspaceId) { const d = await this.repo.getDataset(id); if (d?.workspaceId) return this.forWorkspace(d.workspaceId).failImport(id, error); } await this.repo.updateDataset(id, { status: 'failed', error }); await this.audit(null, 'dataset.import_failed', id, { error }); }
  async deleteDataset(a: Actor, id: string) {
    this.need(a, 'dataset.manage'); await this.stepUp(a, 'dataset.change');
    if ((await this.repo.listSchedules()).some(s => s.datasetId === id)) throw bad('A schedule still uses this dataset. Delete or repoint the schedule first.');
    await this.repo.deleteDataset(id); this.corpusCache.delete(id); await this.audit(a, 'dataset.delete', id);
  }

  // ---------- audits ----------
  async startAudits(a: Actor, i: { datasetId: string; modules: string[]; layer2?: AuditOptions['layer2']; faults?: Partial<Record<AgentName, Fault>>; trigger?: RunRecord['trigger']; scheduleId?: string }) {
    this.need(a, 'audit.request');
    const d = await this.repo.getDataset(i.datasetId); if (!d) throw notFound('Dataset'); if (d.status !== 'ready') throw bad(`Dataset "${d.name}" is ${d.status}.`);
    const mods = expandModules(i.modules, d.modules.map(m => m.id));
    if (!mods.length) throw bad('No modules match. Pick at least one module.');
    if (mods.length > 200) throw bad('At most 200 modules per request.');
    const faults: AuditOptions['faults'] = {};
    for (const ag of AGENTS) { const f = i.faults?.[ag]; if (f && ['flaky', 'offline', 'malformed'].includes(f)) faults[ag] = f; }
    const layer2 = i.layer2 && ['auto', 'llm', 'heuristic'].includes(i.layer2) ? i.layer2 : 'auto';
    const runs: RunRecord[] = [];
    for (const m of mods) {
      const mod = d.modules.find(x => x.id === m)!;
      const r: RunRecord = { id: randomId('run'), datasetId: d.id, datasetName: d.name, program: d.program, baseline: d.baseline, module: m, moduleName: mod.name, dal: mod.dal,
        status: 'queued', options: { module: m, layer2, faults, requestedBy: a.user.name }, requestedBy: a.user.id, requestedByName: a.user.name, createdAt: iso(this.now()),
        attempts: 0, decisions: [], trigger: i.trigger ?? (a.via === 'token' ? 'api' : 'manual'), scheduleId: i.scheduleId ?? null };
      await this.repo.createRun(r); runs.push(r);
      await this.audit(a, 'audit.requested', r.id, { dataset: d.name, module: m, trigger: r.trigger, scheduleId: r.scheduleId, faults });
      if (!this.d.inline) await this.repo.enqueue({ id: randomId('job'), kind: 'audit', payload: { runId: r.id }, status: 'queued', attempts: 0, maxAttempts: 3, runAfter: iso(this.now()), createdAt: iso(this.now()) });
    }
    if (this.d.inline) for (const r of runs) await this.executeAudit(r.id, 1, 1);
    return runs.map(r => r.id);
  }

  /** Called by a worker for one job. Throws to let the queue retry. */
  async executeAudit(runId: string, attempt: number, maxAttempts: number, onEvent?: (e: import('../engine').AuditEvent) => void): Promise<void> {
    if (!this.d.workspaceId && (await this.base.listWorkspaces()).length) {   // the worker: run it inside its own workspace
      const r = await this.repo.getRun(runId, { withResult: false }); if (!r) throw new Error(`Run ${runId} vanished`);
      return this.forWorkspace(wsOf(r)).executeAudit(runId, attempt, maxAttempts, onEvent);
    }
    const run = await this.repo.getRun(runId, { withResult: false }); if (!run) throw new Error(`Run ${runId} vanished`);
    if (!['queued', 'running'].includes(run.status)) return;
    const d = await this.repo.getDataset(run.datasetId); if (!d) { await this.repo.updateRun(runId, { status: 'failed', error: 'Dataset was deleted.' }); return; }
    await this.repo.updateRun(runId, { status: 'running', startedAt: iso(this.now()), attempts: attempt, error: null });
    const settings = await this.getSettings();
    const progress: RunProgress = { phase: 'Starting', messages: [], health: [], updatedAt: iso(this.now()) };
    let last = 0; let pending: Promise<void> | null = null;
    const flush = (force = false) => { const t = Date.now(); if (!force && t - last < 400) return; last = t; progress.updatedAt = iso(new Date()); const snap = { ...progress, messages: progress.messages.slice(-80) }; pending = this.repo.updateRun(runId, { progress: snap }).catch(() => {}); };
    try {
      const corpus = await this.corpusFor(d);
      const llm = this.d.llm ? await this.d.llm(settings) : null;
      const result = await runAudit(corpus, run.options, { runId, llm, pace: this.d.pace, onEvent: e => {
        if (e.kind === 'message') progress.messages.push(e.message); else if (e.kind === 'phase') progress.phase = e.text; else progress.health = e.health;
        onEvent?.(e); flush();
      } });
      flush(true); await pending;
      const policies = await this.repo.listPolicies();
      const pol = selectPolicy(policies, { datasetId: run.datasetId, module: run.module, dal: run.dal, verdict: result.verdict, requestedBy: run.requestedBy });
      await this.repo.updateRun(runId, { status: 'awaiting_approval', verdict: result.verdict, verdictReason: result.verdictReason, result, summary: summarize(result), reportHash: result.reportHash, finishedAt: iso(this.now()),
        policy: { policy: pol, matchedAt: iso(this.now()), reason: pol ? `Matched "${pol.name}" v${pol.version}` : 'No active policy matched' }, progress: null });
      await this.audit(null, 'audit.completed', runId, { module: run.module, verdict: result.verdict, reportHash: result.reportHash, policy: pol?.name ?? null, findings: result.findings.length });
      telemetry.count('aerotrace.audits', 1, { verdict: result.verdict, trigger: run.trigger, dal: run.dal, complete: result.complete });
      for (const h of result.health) if (h.agent !== 'Orchestrator') {
        telemetry.record('aerotrace.agent.step.duration', h.p95Ms, { agent: h.agent });
        if (h.retries) telemetry.count('aerotrace.agent.retries', h.retries, { agent: h.agent });
        if (h.breaker !== 'closed') telemetry.count('aerotrace.agent.breaker_trips', 1, { agent: h.agent, state: h.state });
      }
      const fresh = (await this.repo.getRun(runId, { withResult: false }))!;
      const st = evaluateApproval(pol, fresh, await this.directory(), this.now());
      await this.notify(settings, 'run.awaiting_approval', { run: fresh, verdict: result.verdict, waitingOn: st.waitingOn, approvers: st.steps.filter(s => s.open).flatMap(s => s.eligible.map(e => e.name)) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const final = attempt >= maxAttempts;
      await this.repo.updateRun(runId, { status: final ? 'failed' : 'queued', error: msg });
      this.log(final ? 'error' : 'warn', 'audit attempt failed', { runId, attempt, error: msg });
      if (final) { await this.audit(null, 'audit.failed', runId, { error: msg, attempts: attempt }); await this.notify(settings, 'run.failed', { run, error: msg }); }
      throw e;
    }
  }

  private async directory(): Promise<Directory> {
    const [users, delegations] = await Promise.all([this.repo.listUsers(), this.repo.listDelegations()]);
    return { users: new Map(users.map(u => [u.id, strip(u)])), delegations };
  }
  private async policyFor(run: RunRecord): Promise<ApprovalPolicy | null> {
    if (run.policy?.policy) return run.policy.policy;
    if (run.status !== 'awaiting_approval' || !run.verdict) return null;
    // Nothing matched when the run finished: look again, so an admin can add a policy without re-running.
    return selectPolicy(await this.repo.listPolicies(), { datasetId: run.datasetId, module: run.module, dal: run.dal, verdict: run.verdict, requestedBy: run.requestedBy });
  }
  private async approvalView(run: RunRecord, a: Actor | null, dir?: Directory): Promise<ApprovalView> {
    const pol = await this.policyFor(run);
    dir = dir ?? (await this.directory());
    const st = run.status === 'awaiting_approval' || run.status === 'approved' || run.status === 'denied'
      ? evaluateApproval(pol, run, dir, this.now()) : null;
    const me = st && a ? stepFor(st, a.user.id) : null;
    return {
      status: st?.status ?? 'pending', waitingOn: st?.waitingOn ?? (run.status === 'failed' ? `Failed: ${run.error}` : run.status === 'running' ? 'Audit running' : 'Waiting for a worker'),
      policyName: pol?.name ?? null, policyId: pol?.id ?? null, policyVersion: pol?.version ?? null, sequential: !!pol?.sequential, denyRequiresReason: !!pol?.denyRequiresReason,
      steps: (st?.steps ?? []).map(s => ({ id: s.step.id, name: s.step.name, min: s.step.min, satisfied: s.satisfied, open: s.open,
        approvals: s.approvals.map(x => ({ by: x.userName, at: x.at, onBehalfOf: x.onBehalfOf?.name ?? null })), eligible: s.eligible.map(e => ({ name: e.name, via: e.via })) })),
      canAct: !!me && 'step' in me, actReason: me && 'reason' in me ? me.reason : undefined, myStep: me && 'step' in me ? me.step.step.name : undefined,
      onBehalfOf: me && 'step' in me && me.onBehalfOf ? dir?.users.get(me.onBehalfOf)?.name ?? null : null,
    };
  }
  private canSeeRun(a: Actor, v: ApprovalView) { return this.can(a, 'audit.view') || v.canAct || v.steps.some(s => s.eligible.length); }

  // ---------- program readiness ----------
  private resultCache = new Map<string, AuditRun>();
  private async resultFor(r: RunRecord): Promise<AuditRun | null> {
    if (!['awaiting_approval', 'approved', 'denied'].includes(r.status)) return null;
    const hit = this.resultCache.get(r.id); if (hit) return hit;
    const full = await this.repo.getRun(r.id, { withResult: true }); const res = full?.result ?? null;
    if (res) { this.resultCache.set(r.id, res); if (this.resultCache.size > 400) this.resultCache.delete(this.resultCache.keys().next().value!); }
    return res;
  }
  /** The ready dataset with the most audits (the main program), not simply the newest upload. */
  private async mainDataset(): Promise<Dataset | null> {
    const ready = (await this.repo.listDatasets()).filter(d => d.status === 'ready'); const recent = await this.repo.listRuns({ limit: 1000 });
    return ready.map(d => ({ d, n: recent.filter(r => r.datasetId === d.id).length })).sort((a, b) => b.n - a.n || b.d.modules.length - a.d.modules.length)[0]?.d ?? null;
  }
  /** One picture of the whole program: readiness per module, agent health, message flow, trends, blockers and who can unblock what. */
  async programOverview(a: Actor, datasetId?: string): Promise<ProgramOverview> {
    this.need(a, 'audit.view');
    const ds = (datasetId ? await this.repo.getDataset(datasetId) : null) ?? await this.mainDataset();
    if (!ds) return buildProgramOverview({ dataset: null, modules: [], runs: [], results: new Map(), now: this.now() });
    const runs = await this.repo.listRuns({ datasetId: ds.id, limit: 1000 });
    const latest = new Map<string, RunRecord>(); for (const r of runs) if (!latest.has(r.module) || latest.get(r.module)!.createdAt < r.createdAt) latest.set(r.module, r);
    const want = new Map<string, RunRecord>(); for (const r of latest.values()) want.set(r.id, r);
    for (const r of runs.slice(0, 80)) want.set(r.id, r);
    const results = new Map<string, AuditRun>();
    for (const r of want.values()) { const res = await this.resultFor(r); if (res) results.set(r.id, res); }
    return buildProgramOverview({ dataset: { id: ds.id, name: ds.name, program: ds.program, baseline: ds.baseline, total: ds.total }, modules: ds.modules, runs, results, now: this.now() });
  }
  /** Break agents on purpose and watch retries, breakers and recovery. Same audit, real faults, clearly labelled as a drill. */
  async chaosDrill(a: Actor, i: { datasetId?: string; module: string; preset: ChaosPreset }) {
    const preset = CHAOS_PRESETS[i.preset]; if (!preset) throw bad('Unknown drill.');
    const ds = i.datasetId || (await this.mainDataset())?.id; if (!ds) throw bad('No ready dataset.');
    const [runId] = await this.startAudits(a, { datasetId: ds, modules: [i.module], layer2: 'heuristic', faults: preset.faults });
    await this.audit(a, 'chaos.drill', runId, { preset: i.preset, module: i.module, faults: preset.faults });
    return { runId, preset: { id: i.preset, ...preset } };
  }

  async listRuns(a: Actor, f: { status?: RunRecord['status'][]; limit?: number; datasetId?: string } = {}): Promise<RunView[]> {
    const runs = await this.repo.listRuns({ status: f.status, limit: f.limit ?? 200, datasetId: f.datasetId });
    const dir = await this.directory();
    const out: RunView[] = [];
    for (const r of runs) {
      const approval = await this.approvalView(r, a, dir);
      if (!this.can(a, 'audit.view') && !approval.canAct) continue;
      const { result: _r, progress: _p, ...rest } = r; void _r; void _p;
      out.push({ ...rest, approval });
    }
    return out;
  }
  async inbox(a: Actor) {
    const all = await this.listRuns(a, { status: ['awaiting_approval'] });
    return { mine: all.filter(r => r.approval.canAct), others: this.can(a, 'audit.view') ? all.filter(r => !r.approval.canAct) : [] };
  }
  async getRun(a: Actor, id: string) {
    const r = await this.repo.getRun(id); if (!r) throw notFound('Audit');
    const approval = await this.approvalView(r, a);
    if (!this.canSeeRun(a, approval)) throw forbidden('You cannot view this audit.');
    return { ...r, approval };
  }

  async decide(a: Actor, runId: string, action: 'approve' | 'deny', reason?: string, passkey?: { challengeId: string; response: AuthenticationResponseJSON }) {
    if (action !== 'approve' && action !== 'deny') throw bad('Action must be approve or deny.');
    let audited: DecisionRecord | null = null;
    const signed = await this.decisionProof(a, runId, action, reason?.trim() || null, passkey);
    const dir = await this.directory();
    const updated = await this.repo.decide(runId, async run => {
      if (run.status !== 'awaiting_approval') throw new HttpError(409, run.status === 'approved' ? 'This audit is already approved.' : run.status === 'denied' ? 'This audit was already denied.' : 'This audit has not finished yet.');
      if (!run.result) throw new HttpError(409, 'The report is missing.');
      const pol = await this.policyFor(run);
      const st = evaluateApproval(pol, run, dir, this.now());
      const pick = stepFor(st, a.user.id);
      if ('reason' in pick) throw forbidden(pick.reason);
      if (action === 'deny' && pol!.denyRequiresReason && !reason?.trim()) throw bad(`Policy "${pol!.name}" asks for a reason when denying.`);
      if (!(await verifyChain(run.result.messages))) throw new HttpError(409, 'The agent message trail failed its hash check, so this report cannot be signed.');
      if ((await reportHashFor(run.result)) !== run.reportHash) throw new HttpError(409, 'The report changed after the audit finished, so it cannot be signed.');
      if (signed && signed.reportHash !== run.reportHash) throw new HttpError(409, 'The report changed after you confirmed with your passkey. Review it and confirm again.');
      const behalf = pick.onBehalfOf ? dir.users.get(pick.onBehalfOf) : null;
      const at = iso(this.now());
      const payload = decisionPayload({ run: run.id, step: pick.step.step.id, action, by: a.user.id, onBehalfOf: behalf?.id ?? null, at, reportHash: run.reportHash!, reason: reason?.trim() || null, passkey: signed?.proof ?? null });
      const decision: DecisionRecord = { id: randomId('dec'), runId, stepId: pick.step.step.id, stepName: pick.step.step.name, action, userId: a.user.id, userName: a.user.name,
        onBehalfOf: behalf ? { id: behalf.id, name: behalf.name } : null, reason: reason?.trim() || null, at, reportHash: run.reportHash!, signature: await this.d.signer.sign(payload), passkey: signed?.proof ?? null };
      audited = decision;
      if (action === 'deny') return { decision, status: 'denied' };
      const after = evaluateApproval(pol, { ...run, decisions: [...run.decisions, decision] }, dir, this.now());
      return { decision, status: after.status === 'approved' ? 'approved' : 'awaiting_approval' };
    });
    const d = audited as DecisionRecord | null;
    if (!updated.policy?.policy) { const pol = await this.policyFor(updated); if (pol) await this.repo.updateRun(runId, { policy: { policy: pol, matchedAt: iso(this.now()), reason: `Matched "${pol.name}" v${pol.version} at decision time` } }); }
    await this.audit(a, `decision.${action}`, runId, { step: d?.stepName, onBehalfOf: d?.onBehalfOf?.name ?? null, reason: d?.reason ?? null, reportHash: d?.reportHash, signature: d?.signature.value.slice(0, 32), passkey: d?.passkey ? { id: d.passkey.credentialId.slice(0, 16), userVerified: d.passkey.userVerified } : null, resultingStatus: updated.status });
    const settings = await this.getSettings();
    if (updated.status !== 'awaiting_approval') await this.notify(settings, updated.status === 'approved' ? 'run.approved' : 'run.denied', { run: updated, by: a.user.name, reason });
    return this.getRun(a, runId);
  }

  /** Independent re-check of a finished audit: trail, report hash and every signature. */
  async verifyRun(a: Actor, runId: string) {
    const r = await this.getRun(a, runId);
    if (!r.result) return { ok: false, checks: [{ name: 'Report', ok: false, detail: 'No report yet.' }] };
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const chain = await verifyChain(r.result.messages); checks.push({ name: 'Agent message trail', ok: chain, detail: `${r.result.messages.length} messages, hash chain ${chain ? 'intact' : 'broken'}` });
    const h = await reportHashFor(r.result); checks.push({ name: 'Report hash', ok: h === r.reportHash, detail: h === r.reportHash ? `matches ${h.slice(0, 16)}…` : 'report content changed after the audit' });
    for (const d of r.decisions) {
      const payload = decisionPayload({ run: r.id, step: d.stepId, action: d.action, by: d.userId, onBehalfOf: d.onBehalfOf?.id ?? null, at: d.at, reportHash: d.reportHash, reason: d.reason ?? null, passkey: d.passkey ?? null });
      const ok = (await this.d.signer.verify(payload, d.signature)) && d.reportHash === r.reportHash;
      checks.push({ name: `${d.action === 'approve' ? 'Approval' : 'Denial'} by ${d.userName}`, ok, detail: `${d.signature.alg} key ${d.signature.keyId} · ${ok ? 'signature valid' : 'signature INVALID'}` });
      if (d.passkey) {
        const p = d.passkey;
        const want = await decisionChallenge({ run: r.id, action: d.action, reportHash: d.reportHash, reason: d.reason ?? null, by: d.userId, nonce: p.nonce ?? '' });
        const c = await verifyPasskeyProof(p, want);
        checks.push({ name: `${d.userName}'s passkey`, ok: c.ok, detail: c.detail });
      }
    }
    return { ok: checks.every(c => c.ok), checks };
  }

  async evidencePackage(a: Actor, runId: string) {
    await this.stepUp(a, 'evidence.export');
    const r = await this.getRun(a, runId);
    const events = (await this.repo.allAudit()).filter(e => e.target === runId);
    return { format: 'aerotrace-evidence/1', generatedAt: iso(this.now()), generatedBy: a.user.name,
      signer: { alg: this.d.signer.alg, keyId: this.d.signer.keyId, publicKey: this.d.signer.publicKey(), publicKeys: this.d.signer.publicKeys?.() ?? [] },
      run: r, verification: await this.verifyRun(a, runId), auditEvents: events,
      howToVerify: 'Recompute the report hash from run.result with reportBodyFor(), then check each decision signature over canonical({run,step,action,by,onBehalfOf,at,reportHash,reason,passkey?: "credentialId:challenge:publicKey"}) with the public key, and each passkey assertion against the approver\'s public key and a challenge recomputed from the decision. scripts/verify-evidence.mjs does all three.' };
  }

  async diff(a: Actor, runId: string) {
    const r = await this.getRun(a, runId); if (!r.result) return null;
    const prev = (await this.repo.listRuns({ datasetId: r.datasetId, module: r.module, status: ['approved', 'denied', 'awaiting_approval'], limit: 20 })).find(x => x.createdAt < r.createdAt);
    if (!prev) return { previous: null, added: [], resolved: [], unchanged: 0 };
    const p = await this.repo.getRun(prev.id); if (!p?.result) return { previous: null, added: [], resolved: [], unchanged: 0 };
    const key = (f: { kind: string; ref: string }) => `${f.kind}|${f.ref}`;
    const cur = r.result.findings.filter(f => f.status === 'confirmed'), old = p.result.findings.filter(f => f.status === 'confirmed');
    const ok = new Set(old.map(key)), nk = new Set(cur.map(key));
    return { previous: { id: p.id, createdAt: p.createdAt, verdict: p.verdict, status: p.status },
      added: cur.filter(f => !ok.has(key(f))).map(f => ({ severity: f.severity, title: f.title, agent: f.agent })),
      resolved: old.filter(f => !nk.has(key(f))).map(f => ({ severity: f.severity, title: f.title, agent: f.agent })),
      unchanged: cur.filter(f => ok.has(key(f))).length };
  }

  // ---------- evidence sources ----------
  async listSources() { return this.repo.listSources(); }
  async saveSource(a: Actor, i: Partial<EvidenceSource> & { name: string; git: EvidenceSource['git'] }) {
    this.need(a, 'dataset.manage'); await this.stepUp(a, 'dataset.change');
    const prev = i.id ? await this.repo.getSource(i.id) : null; if (i.id && !prev) throw notFound('Evidence source');
    const str = (v: unknown, max = 500) => (v == null ? '' : String(v).trim()).slice(0, max);
    const name = str(i.name, 120); if (!name) throw bad('Name the source, for example "FCC-2 main".');
    const g = i.git ?? ({} as EvidenceSource['git']);
    if (!['github', 'gitlab'].includes(g.provider)) throw bad('Git provider must be github or gitlab.');
    const repo = str(g.repo, 200); if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) throw bad('Repository is "owner/name" (GitLab: "group/subgroup/project").');
    const root = str(g.root).replace(/^\/+|\/+$/g, ''); if (root.split('/').includes('..')) throw bad('The bundle folder cannot contain "..".');
    const git: EvidenceSource['git'] = { provider: g.provider, repo, ref: str(g.ref, 200) || 'main', ...(str(g.baseUrl) ? { baseUrl: str(g.baseUrl) } : {}),
      ...(root ? { root } : {}), ...(str(g.baselineRef, 200) ? { baselineRef: str(g.baselineRef, 200) } : {}), ...(str(g.tokenRef) ? { tokenRef: str(g.tokenRef) } : {}) };
    let jira: EvidenceSource['jira'] = null;
    if (i.jira) {
      const j = i.jira;
      if (!str(j.baseUrl) || !str(j.jql, 2000)) throw bad('Jira needs a site URL and a JQL query.');
      if (!['cloud', 'server'].includes(j.deployment)) throw bad('Jira deployment is cloud or server.');
      if (!['basic', 'bearer'].includes(j.auth)) throw bad('Jira authentication is basic (email + API token) or bearer (personal access token).');
      if (!str(j.tokenRef)) throw bad('Jira needs a token reference.');
      if (j.auth === 'basic' && !str(j.email)) throw bad('Basic authentication to Jira needs the account email.');
      jira = { baseUrl: str(j.baseUrl), deployment: j.deployment, jql: str(j.jql, 2000), auth: j.auth, tokenRef: str(j.tokenRef), ...(str(j.email) ? { email: str(j.email) } : {}),
        ...(str(j.moduleField, 80) ? { moduleField: str(j.moduleField, 80) } : {}), ...(str(j.filesField, 80) ? { filesField: str(j.filesField, 80) } : {}) };
    }
    let ci: EvidenceSource['ci'] = null;
    if (i.ci) {
      const c = i.ci;
      if (!['github-actions', 'gitlab', 'urls'].includes(c.kind)) throw bad('CI is github-actions, gitlab or urls.');
      if (c.kind === 'github-actions' && git.provider !== 'github') throw bad('GitHub Actions results need a GitHub repository.');
      if (c.kind === 'gitlab' && (git.provider !== 'gitlab' || !str(c.job))) throw bad('GitLab artifacts need a GitLab project and a job name.');
      const urls = (c.junitUrls ?? []).map(u => str(u)).filter(Boolean).slice(0, 50);
      if (c.kind === 'urls' && !urls.length && !str(c.coverageUrl)) throw bad('Give at least one JUnit or coverage URL.');
      ci = { kind: c.kind, ...(str(c.workflow, 200) ? { workflow: str(c.workflow, 200) } : {}), ...(str(c.artifact, 200) ? { artifact: str(c.artifact, 200) } : {}), ...(str(c.job, 200) ? { job: str(c.job, 200) } : {}),
        ...(urls.length ? { junitUrls: urls } : {}), ...(str(c.coverageUrl) ? { coverageUrl: str(c.coverageUrl) } : {}), ...(str(c.tokenRef) ? { tokenRef: str(c.tokenRef) } : {}) };
    }
    const autoAudit = i.autoAudit?.modules?.length ? { modules: i.autoAudit.modules.map(m => str(m, 80)).filter(Boolean), layer2: (['auto', 'llm', 'heuristic'].includes(i.autoAudit.layer2) ? i.autoAudit.layer2 : 'auto') as 'auto' } : null;
    const src: EvidenceSource = { id: prev?.id ?? randomId('src'), name, git, jira, ci, autoAudit, lastSync: prev?.lastSync ?? null,
      createdBy: prev?.createdBy ?? a.user.id, createdAt: prev?.createdAt ?? iso(this.now()), updatedAt: iso(this.now()) };
    const problems = this.d.sources?.check(src) ?? []; if (problems.length) throw bad(problems.join(' '));
    if (prev) await this.repo.updateSource(src.id, src); else await this.repo.createSource(src);
    await this.audit(a, prev ? 'source.update' : 'source.create', src.id, { name, git: { provider: git.provider, repo: git.repo, ref: git.ref, root: git.root ?? '', baselineRef: git.baselineRef ?? null, tokenRef: git.tokenRef ?? null },
      jira: jira ? { baseUrl: jira.baseUrl, jql: jira.jql, tokenRef: jira.tokenRef } : null, ci: ci ? { kind: ci.kind, tokenRef: ci.tokenRef ?? null } : null, autoAudit });
    return src;
  }
  async deleteSource(a: Actor, id: string) {
    this.need(a, 'dataset.manage'); await this.stepUp(a, 'dataset.change');
    if (!(await this.repo.getSource(id))) throw notFound('Evidence source');
    if ((await this.repo.listSchedules()).some(s => s.sourceId === id)) throw bad('A schedule syncs this source. Delete or change the schedule first.');
    await this.repo.deleteSource(id); await this.audit(a, 'source.delete', id);
  }
  /** Dry run: fetch and build the bundle, import it in memory, store nothing. Shows what a sync would produce. */
  async testSource(a: Actor, id: string) {
    this.need(a, 'dataset.manage');
    const src = await this.repo.getSource(id); if (!src) throw notFound('Evidence source');
    if (!this.d.sources) throw bad('Testing a source needs the deployed server. The browser demo cannot reach Git, Jira or CI.');
    let out; try { out = await this.d.sources.sync(src); } catch (e) { return { ok: false as const, error: (e as Error).message }; }
    try {
      const { corpus, warnings } = await importBundle(out.bundle);
      return { ok: true as const, commit: out.provenance.git.commit, program: corpus.program, baseline: corpus.baseline, modules: corpus.modules.map(m => m.id), total: corpus.total, counts: corpus.counts,
        bytes: out.bundle.byteLength, unchanged: src.lastSync?.inputsSha256 === out.provenance.inputsSha256, provenance: out.provenance, warnings: [...out.warnings, ...warnings] };
    } catch (e) { return { ok: false as const, error: `The bundle does not import: ${(e as Error).message}` }; }
  }
  /** Sync now. Queued for a worker on the server; done in place when running inline. */
  async requestSync(a: Actor, id: string): Promise<{ queued: true } | SyncResult> {
    this.need(a, 'dataset.manage');
    const src = await this.repo.getSource(id); if (!src) throw notFound('Evidence source');
    if (!this.d.sources) throw bad('Syncing from Git, Jira and CI needs the deployed server. The browser demo cannot reach them.');
    await this.audit(a, 'source.sync_requested', id, { name: src.name });
    if (this.d.inline) return this.executeSync(id, { requestedBy: a.user.id });
    await this.repo.enqueue({ id: randomId('job'), kind: 'sync', payload: { sourceId: id, requestedBy: a.user.id }, status: 'queued', attempts: 0, maxAttempts: 3, runAfter: iso(this.now()), createdAt: iso(this.now()) });
    return { queued: true };
  }
  /** Fetch, build, import, and audit if asked. Called by a worker (or inline). Throws to let the queue retry. */
  async executeSync(id: string, p: { requestedBy?: string; scheduleId?: string } = {}): Promise<SyncResult> {
    if (!this.d.workspaceId) { const s = await this.repo.getSource(id); if (!s) throw new Error(`Evidence source ${id} vanished`); return this.forWorkspace(wsOf(s)).executeSync(id, p); }
    const src = await this.repo.getSource(id); if (!src) throw new Error(`Evidence source ${id} vanished`);
    if (!this.d.sources) throw new Error('No connectors in this process.');
    const at = iso(this.now()); const sched = p.scheduleId ? await this.repo.getSchedule(p.scheduleId) : null;
    const fail = async (msg: string) => {
      await this.repo.updateSource(id, { lastSync: { ...(src.lastSync ?? {}), at, status: 'failed', error: msg, runIds: [] } });
      if (sched) await this.repo.updateSchedule(sched.id, { lastError: `Sync failed: ${msg}` });
      await this.audit(null, 'source.sync_failed', id, { name: src.name, error: msg });
    };
    let out: Awaited<ReturnType<NonNullable<Deps['sources']>['sync']>>;
    try { out = await telemetry.span('evidence sync', { 'aerotrace.source.id': id, 'aerotrace.source.provider': src.git.provider }, () => this.d.sources!.sync(src)); }
    catch (e) { await fail((e as Error).message); throw e; }
    const prov: Provenance = { ...out.provenance, sourceId: src.id, sourceName: src.name, fetchedAt: at };
    const prevDs = src.lastSync?.inputsSha256 === prov.inputsSha256 && src.lastSync?.datasetId ? await this.repo.getDataset(src.lastSync.datasetId) : null;
    let datasetId: string; let status: 'ok' | 'unchanged'; let warnings = out.warnings;
    if (prevDs?.status === 'ready') { datasetId = prevDs.id; status = 'unchanged'; }
    else {
      let imported: Awaited<ReturnType<typeof importBundle>>;
      try { imported = await importBundle(out.bundle); } catch (e) { const msg = `The bundle built from ${src.git.repo}@${prov.git.commit.slice(0, 12)} does not import: ${(e as Error).message}`; await fail(msg); throw new Error(msg); }
      warnings = [...out.warnings, ...imported.warnings];
      const owner = p.requestedBy ? await this.repo.getUser(p.requestedBy) : null;
      const d: Dataset = { id: randomId('ds'), name: `${src.name} @ ${prov.git.commit.slice(0, 7)}`, program: imported.corpus.program, baseline: imported.corpus.baseline, source: 'bundle', status: 'importing',
        total: 0, counts: {}, modules: [], warnings: [], createdBy: owner?.name ?? 'Evidence sync', createdAt: at, provenance: prov };
      await this.repo.createDataset(d, out.bundle);
      await this.completeImport(d.id, imported.corpus, warnings);
      datasetId = d.id; status = 'ok';
    }
    // Audits: a schedule always audits (that is its job); a source's own auto-audit only runs on new evidence.
    let runIds: string[] = [];
    if (sched) runIds = await this.fireSchedule({ ...sched, sourceId: null, datasetId });
    else if (status === 'ok' && src.autoAudit) {
      const who = await this.repo.getUser(p.requestedBy ?? src.createdBy);
      if (who?.active) { const actor = await this.actorFor(who); if (this.can(actor, 'audit.request')) runIds = await this.startAudits(actor, { datasetId, modules: src.autoAudit.modules, layer2: src.autoAudit.layer2, trigger: 'api' }); }
    }
    if (sched) await this.repo.updateSchedule(sched.id, { datasetId, lastRunAt: at, lastRunIds: runIds, lastError: null });
    await this.repo.updateSource(id, { lastSync: { at, status, datasetId, commit: prov.git.commit, inputsSha256: prov.inputsSha256, error: null, runIds } });
    await this.audit(null, 'source.synced', id, { name: src.name, status, datasetId, commit: prov.git.commit, ref: prov.git.ref, baseline: prov.git.baselineCommit,
      jiraIssues: prov.jira?.issues ?? null, ciRun: prov.ci?.run ?? null, inputsSha256: prov.inputsSha256, warnings: warnings.length, runs: runIds.length });
    telemetry.count('aerotrace.syncs', 1, { status });
    return { status, datasetId, commit: prov.git.commit, runIds, warnings };
  }

  // ---------- schedules ----------
  async listSchedules() { return this.repo.listSchedules(); }
  async saveSchedule(a: Actor, i: Partial<Schedule> & { name: string; datasetId: string; modules: string[]; recurrence: Recurrence; timezone: string }) {
    this.need(a, 'schedule.manage'); await this.stepUp(a, 'schedule.change');
    if (!i.name?.trim()) throw bad('Name the schedule.');
    let datasetId = i.datasetId;
    if (i.sourceId) {
      const src = await this.repo.getSource(i.sourceId); if (!src) throw bad('Pick an evidence source.');
      datasetId = src.lastSync?.datasetId ?? i.datasetId ?? '';
      const d = datasetId ? await this.repo.getDataset(datasetId) : null;
      if (d && !expandModules(i.modules, d.modules.map(m => m.id)).length) throw bad('No modules in the latest sync of that source match.');
      if (!i.modules?.length) throw bad('Pick at least one module.');
    } else {
      const d = await this.repo.getDataset(i.datasetId); if (!d) throw bad('Pick a dataset.');
      if (!expandModules(i.modules, d.modules.map(m => m.id)).length) throw bad('No modules in that dataset match.');
    }
    try { validateRecurrence(i.recurrence, i.timezone); } catch (e) { throw bad((e as Error).message); }
    const prev = i.id ? await this.repo.getSchedule(i.id) : null;
    if (i.id && !prev) throw notFound('Schedule');
    const owner = prev ? { id: prev.ownerId, name: prev.ownerName } : { id: a.user.id, name: a.user.name };
    const enabled = i.enabled !== false;
    const s: Schedule = { id: prev?.id ?? randomId('sch'), name: i.name.trim(), datasetId, sourceId: i.sourceId || null, modules: i.modules, layer2: i.layer2 ?? 'auto', recurrence: i.recurrence, timezone: i.timezone,
      enabled, skipIfPending: i.skipIfPending !== false, notifyOn: i.notifyOn ?? ['NO', 'failed'], ownerId: owner.id, ownerName: owner.name,
      nextRunAt: enabled ? iso(nextRun(i.recurrence, i.timezone, this.now())) : null, lastRunAt: prev?.lastRunAt ?? null, lastRunIds: prev?.lastRunIds ?? [], lastError: null,
      createdAt: prev?.createdAt ?? iso(this.now()), updatedAt: iso(this.now()) };
    if (prev) await this.repo.updateSchedule(s.id, s); else await this.repo.createSchedule(s);
    await this.audit(a, prev ? 'schedule.update' : 'schedule.create', s.id, { name: s.name, sourceId: s.sourceId, recurrence: describeRecurrence(s.recurrence, s.timezone), modules: s.modules, enabled, nextRunAt: s.nextRunAt });
    return s;
  }
  async deleteSchedule(a: Actor, id: string) { this.need(a, 'schedule.manage'); await this.stepUp(a, 'schedule.change'); await this.repo.deleteSchedule(id); await this.audit(a, 'schedule.delete', id); }
  async runScheduleNow(a: Actor, id: string) {
    this.need(a, 'schedule.manage');
    const s = await this.repo.getSchedule(id); if (!s) throw notFound('Schedule');
    const ids = await this.fireSchedule(s, a);
    await this.repo.updateSchedule(id, { lastRunAt: iso(this.now()), lastRunIds: ids, lastError: null });
    return ids;
  }
  async fireSchedule(s: Schedule, trigger?: Actor): Promise<string[]> {
    const owner = await this.repo.getUser(s.ownerId);
    if (!owner || !owner.active) throw new Error(`Owner ${s.ownerName} is no longer active; reassign the schedule.`);
    const ownerActor = await this.actorFor(owner);
    if (!this.can(ownerActor, 'audit.request')) throw new Error(`Owner ${s.ownerName} no longer has permission to start audits.`);
    if (s.sourceId) {   // sync first, then audit what the sync produced (executeSync calls back here without sourceId)
      if (!this.d.sources) throw new Error('Syncing an evidence source needs the deployed server.');
      if (this.d.inline) return (await this.executeSync(s.sourceId, { scheduleId: s.id, requestedBy: s.ownerId })).runIds;
      await this.repo.enqueue({ id: randomId('job'), kind: 'sync', payload: { sourceId: s.sourceId, scheduleId: s.id, requestedBy: s.ownerId }, status: 'queued', attempts: 0, maxAttempts: 3, runAfter: iso(this.now()), createdAt: iso(this.now()) });
      await this.audit(trigger ?? null, 'schedule.fired', s.id, { sync: s.sourceId, by: trigger ? trigger.user.name : 'scheduler' });
      return [];
    }
    const d = await this.repo.getDataset(s.datasetId); if (!d) throw new Error('Its dataset was deleted.');
    let mods = expandModules(s.modules, d.modules.map(m => m.id));
    if (s.skipIfPending) {
      const pending = await this.repo.listRuns({ datasetId: s.datasetId, status: ['queued', 'running', 'awaiting_approval'], limit: 1000 });
      const busy = new Set(pending.filter(r => r.scheduleId === s.id).map(r => r.module));
      mods = mods.filter(m => !busy.has(m));
      if (!mods.length) { await this.audit(trigger ?? null, 'schedule.skipped', s.id, { reason: 'previous runs still pending' }); return []; }
    }
    const ids = await this.startAudits(ownerActor, { datasetId: s.datasetId, modules: mods, layer2: s.layer2, trigger: 'schedule', scheduleId: s.id });
    await this.audit(trigger ?? null, 'schedule.fired', s.id, { runs: ids.length, by: trigger ? trigger.user.name : 'scheduler' });
    return ids;
  }
  /** One scheduler tick. Safe to call from every worker at once. */
  async tickSchedules(): Promise<number> {
    return this.repo.claimDueSchedules(this.now(), async s => {
      const next = iso(nextRun(s.recurrence, s.timezone, this.now()));
      try { const ids = await (this.d.workspaceId ? this : this.forWorkspace(wsOf(s))).fireSchedule(s); return { lastRunAt: iso(this.now()), lastRunIds: ids, lastError: null, nextRunAt: next }; }
      catch (e) { const msg = (e as Error).message; this.log('warn', 'schedule failed', { schedule: s.id, error: msg }); return { lastError: msg, nextRunAt: next }; }
    });
  }

  // ---------- assistant ----------
  /** Answers a question about the audits this person can see. Every sentence cites its sources. */
  async ask(a: Actor, question: string, opts: { runId?: string; timezone?: string } = {}): Promise<Answer> {
    const q = String(question || '').slice(0, 1000);
    let cache: RunView[] | null = null; const full = new Map<string, Promise<RunView & Pick<RunRecord, 'result'>>>();
    const data: AssistantData = {
      me: { id: a.user.id, name: a.user.name },
      runs: async () => (cache ??= await this.listRuns(a, { limit: 500 })),
      run: id => { let p = full.get(id); if (!p) { p = this.getRun(a, id); full.set(id, p); } return p; },
      diff: id => this.diff(a, id),
      schedules: () => this.listSchedules(),
      policies: () => this.listPolicies(),
      inbox: () => this.inbox(a),
      describe: s => describeRecurrence(s.recurrence, s.timezone),
      timezone: opts.timezone && validTz(opts.timezone) ? opts.timezone : 'UTC',
    };
    const settings = await this.getSettings();
    const llm = this.d.llm ? await this.d.llm(settings).catch(() => null) : null;
    const ans = llm ? await answerLLM(q, data, llm, opts.runId).catch(() => answerRules(q, data, opts.runId)) : await answerRules(q, data, opts.runId);
    await this.audit(a, 'assistant.asked', opts.runId ?? 'assistant', { question: q.slice(0, 200), mode: ans.mode, citations: ans.citations.length, abstained: !!ans.abstained, proposal: !!ans.proposal });
    return ans;
  }

  // ---------- repetitive-audit detection ----------
  /** Modules someone keeps auditing by hand on a regular rhythm, with no schedule covering them. */
  async automationSuggestions(a: Actor, timezone = 'UTC') {
    const tz = validTz(timezone) ? timezone : 'UTC';
    const since = this.now().getTime() - 90 * 86400e3;
    const runs = (await this.repo.listRuns({ limit: 1000 })).filter(r => r.trigger !== 'schedule' && Date.parse(r.createdAt) >= since);
    const schedules = (await this.repo.listSchedules()).filter(s => s.enabled);
    const dismissed = new Set((await this.getSettings()).dismissedSuggestions ?? []);
    const groups = new Map<string, RunRecord[]>();
    for (const r of runs) { const k = `${r.datasetId}|${r.module}`; const g = groups.get(k) ?? []; g.push(r); groups.set(k, g); }
    const hourOf = (iso: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso))) % 24;
    const dayOf = (iso: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(iso)));
    const median = (xs: number[]) => { const s = [...xs].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    const out: { key: string; datasetId: string; datasetName: string; module: string; count: number; everyHours: number; lastAt: string; recurrence: Recurrence; timezone: string; description: string; runIds: string[] }[] = [];
    for (const [key, list] of groups) {
      if (list.length < 3 || dismissed.has(key)) continue;
      const [datasetId, module] = key.split('|');
      if (schedules.some(s => s.datasetId === datasetId && expandModules(s.modules, [module]).length)) continue;
      const times = list.map(r => Date.parse(r.createdAt)).sort((x, y) => x - y);
      // collapse bursts (several runs within 2 hours count as one sitting)
      const sittings = times.filter((t, i) => i === 0 || t - times[i - 1] > 2 * 3600e3);
      if (sittings.length < 3) continue;
      const gaps = sittings.slice(1).map((t, i) => (t - sittings[i]) / 3600e3);
      const g = median(gaps);
      if (g < 3 || g > 24 * 31 || !gaps.every(x => Math.abs(x - g) <= Math.max(2, g * 0.35))) continue;
      const isoTimes = sittings.map(t => new Date(t).toISOString());
      const hour = Math.round(median(isoTimes.map(hourOf)));
      let recurrence: Recurrence;
      if (Math.abs(g - 24) <= 6) recurrence = { kind: 'daily', time: `${String(hour).padStart(2, '0')}:00` };
      else if (Math.abs(g - 168) <= 30) { const days = isoTimes.map(dayOf); const common = [...new Set(days)].sort((x, y) => days.filter(d => d === y).length - days.filter(d => d === x).length)[0]; recurrence = { kind: 'weekly', days: [common], time: `${String(hour).padStart(2, '0')}:00` }; }
      else recurrence = { kind: 'interval', everyMinutes: Math.max(60, Math.round(g) * 60) };
      out.push({ key, datasetId, datasetName: list[0].datasetName, module, count: list.length, everyHours: Math.round(g * 10) / 10, lastAt: new Date(times.at(-1)!).toISOString(), recurrence, timezone: tz,
        description: `${list.length} manual audits, about every ${g >= 36 ? `${Math.round(g / 24)} days` : `${Math.round(g)} hours`}`, runIds: list.slice(0, 10).map(r => r.id) });
    }
    void a;
    return out.sort((x, y) => y.count - x.count);
  }
  async dismissSuggestion(a: Actor, key: string) {
    this.need(a, 'schedule.manage');
    const s = await this.getSettings();
    await this.repo.putSettings({ ...s, dismissedSuggestions: [...new Set([...(s.dismissedSuggestions ?? []), key])].slice(-500) });
    await this.audit(a, 'automation.suggestion_dismissed', key);
  }

  // ---------- audit log ----------
  async auditLog(a: Actor, limit = 200, beforeSeq?: number): Promise<AuditEvent[]> { this.need(a, 'auditlog.view'); return this.repo.listAudit({ limit: Math.min(limit, 1000), beforeSeq }); }
  async verifyAuditLog(a: Actor) { this.need(a, 'auditlog.view'); return verifyAuditChain(await this.repo.allAudit()); }

  private async notify(s: Settings, event: string, payload: Record<string, unknown>) {
    if (!this.d.notify || !s.notifications.events.includes(event)) return;
    const run = payload.run as RunRecord | undefined;
    if (run?.scheduleId) {
      const sch = await this.repo.getSchedule(run.scheduleId);
      const key = event === 'run.failed' ? 'failed' : (payload.verdict as string | undefined) ?? run.verdict ?? '';
      if (event === 'run.awaiting_approval' && sch && !sch.notifyOn.includes(key as Schedule['notifyOn'][number])) return;
    }
    try { await this.d.notify(s, event, payload); } catch (e) { this.log('warn', 'notification failed', { event, error: String(e) }); }
  }
}

function validTz(tz: string) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

export function expandModules(patterns: string[], available: string[]): string[] {
  if (!patterns.length) return [];
  const out = new Set<string>();
  for (const p of patterns) {
    const t = p.trim().toUpperCase(); if (!t) continue;
    if (t === '*' || t === 'ALL') { available.forEach(m => out.add(m)); continue; }
    const re = new RegExp('^' + t.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    available.filter(m => re.test(m.toUpperCase())).forEach(m => out.add(m));
  }
  return available.filter(m => out.has(m));
}

export function checkPassword(p: string) {
  if (p.length < 12) throw bad('Passwords need at least 12 characters.');
  if (!/[a-z]/i.test(p) || !/\d/.test(p)) throw bad('Use letters and at least one number.');
}

/** What the gate's own key signs for a decision. Includes the passkey proof when there is one, so neither can be swapped. */
export function decisionPayload(f: { run: string; step: string; action: string; by: string; onBehalfOf: string | null; at: string; reportHash: string; reason: string | null; passkey?: { credentialId: string; challenge: string; publicKey: string } | null }) {
  const base = { run: f.run, step: f.step, action: f.action, by: f.by, onBehalfOf: f.onBehalfOf, at: f.at, reportHash: f.reportHash, reason: f.reason };
  return canonical(f.passkey ? { ...base, passkey: `${f.passkey.credentialId}:${f.passkey.challenge}:${f.passkey.publicKey}` } : base);
}
