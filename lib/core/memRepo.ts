// In-memory Repo for tests and the browser demo. Same behaviour as PgRepo, minus durability.
import type { Repo, RunFilter } from './repo';
import type { Workspace, User, Group, Role, ApprovalPolicy, Delegation, ApiToken, Session, Settings, Passkey, PasskeyChallenge, Invite, EvidenceSource, Dataset, RunRecord, Job, AuditEvent, AuditEventInput, Schedule } from './model';
import { DEFAULT_SETTINGS } from './model';
import type { Corpus } from '../engine/types';
import { auditHash } from './auditHash';

const clone = <T,>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

export class MemRepo implements Repo {
  kind = 'memory' as const;
  workspaces = new Map<string, Workspace>(); scopedSettings = new Map<string, Settings>();
  async listWorkspaces() { return [...this.workspaces.values()].map(clone).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  async createWorkspace(w: Workspace) { if ([...this.workspaces.values()].some(x => x.slug === w.slug)) throw new Error(`A workspace called ${w.slug} already exists.`); this.workspaces.set(w.id, clone(w)); }
  async updateWorkspace(id: string, p: Partial<Workspace>) { const w = this.workspaces.get(id); if (w) this.workspaces.set(id, { ...w, ...clone(p) }); }
  users = new Map<string, User>(); groups = new Map<string, Group>(); roles = new Map<string, Role>();
  policies = new Map<string, ApprovalPolicy>(); delegations = new Map<string, Delegation>(); tokens = new Map<string, ApiToken>();
  sessions = new Map<string, Session>(); attempts: { key: string; ok: boolean; at: string }[] = [];
  settings: Settings = clone(DEFAULT_SETTINGS); secrets = new Map<string, string>();
  datasets = new Map<string, Dataset>(); bundles = new Map<string, Uint8Array>(); corpora = new Map<string, Corpus>();
  runs = new Map<string, RunRecord>(); schedules = new Map<string, Schedule>(); jobs = new Map<string, Job>(); audit: AuditEvent[] = [];
  // One lock per area, like row locks in Postgres, so a schedule claim can write audit events without deadlocking.
  private chains = new Map<string, Promise<unknown>>();
  private lockOn<T>(area: string, fn: () => Promise<T>): Promise<T> { const p = (this.chains.get(area) ?? Promise.resolve()).then(fn); this.chains.set(area, p.catch(() => {})); return p; }

  async listUsers() { return [...this.users.values()].map(clone); }
  async getUser(id: string) { return clone(this.users.get(id) ?? null); }
  async getUserByEmail(e: string) { return clone([...this.users.values()].find(u => u.email.toLowerCase() === e.toLowerCase()) ?? null); }
  async createUser(u: User) { if (await this.getUserByEmail(u.email)) throw new Error(`A user with email ${u.email} already exists.`); this.users.set(u.id, clone(u)); }
  async updateUser(id: string, p: Partial<User>) { const u = this.users.get(id); if (u) this.users.set(id, { ...u, ...clone(p) }); }
  async listGroups() { return [...this.groups.values()].map(clone); }
  async createGroup(g: Group) { if ([...this.groups.values()].some(x => x.name.toLowerCase() === g.name.toLowerCase())) throw new Error(`A group named ${g.name} already exists.`); this.groups.set(g.id, clone(g)); }
  async updateGroup(id: string, p: Partial<Group>) { const g = this.groups.get(id); if (g) this.groups.set(id, { ...g, ...clone(p) }); }
  async deleteGroup(id: string) { this.groups.delete(id); for (const u of this.users.values()) u.groupIds = u.groupIds.filter(x => x !== id); }
  async listRoles() { return [...this.roles.values()].map(clone); }
  async createRole(r: Role) { this.roles.set(r.id, clone(r)); }
  async updateRole(id: string, p: Partial<Role>) { const r = this.roles.get(id); if (r) this.roles.set(id, { ...r, ...clone(p) }); }
  async deleteRole(id: string) { this.roles.delete(id); for (const u of this.users.values()) u.roleIds = u.roleIds.filter(x => x !== id); for (const g of this.groups.values()) g.roleIds = g.roleIds.filter(x => x !== id); }
  async listPolicies() { return [...this.policies.values()].map(clone); }
  async createPolicy(p: ApprovalPolicy) { this.policies.set(p.id, clone(p)); }
  async updatePolicy(id: string, p: ApprovalPolicy) { this.policies.set(id, clone(p)); }
  async deletePolicy(id: string) { this.policies.delete(id); }
  async listDelegations() { return [...this.delegations.values()].map(clone); }
  async createDelegation(d: Delegation) { this.delegations.set(d.id, clone(d)); }
  async updateDelegation(id: string, p: Partial<Delegation>) { const d = this.delegations.get(id); if (d) this.delegations.set(id, { ...d, ...clone(p) }); }
  async listTokens() { return [...this.tokens.values()].map(clone); }
  async createToken(t: ApiToken) { this.tokens.set(t.id, clone(t)); }
  async getTokenByHash(h: string) { return clone([...this.tokens.values()].find(t => t.tokenHash === h) ?? null); }
  async updateToken(id: string, p: Partial<ApiToken>) { const t = this.tokens.get(id); if (t) this.tokens.set(id, { ...t, ...clone(p) }); }
  async createSession(s: Session) { this.sessions.set(s.id, clone(s)); }
  async getSessionByHash(h: string) { return clone([...this.sessions.values()].find(s => s.tokenHash === h) ?? null); }
  async deleteSession(id: string) { this.sessions.delete(id); }
  async deleteUserSessions(userId: string) { for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k); }
  async updateSession(id: string, p: Partial<Session>) { const s = this.sessions.get(id); if (s) this.sessions.set(id, { ...s, ...clone(p) }); }
  passkeys = new Map<string, Passkey>(); challenges = new Map<string, PasskeyChallenge>();
  async listPasskeys(userId?: string) { return [...this.passkeys.values()].filter(p => !userId || p.userId === userId).map(clone); }
  async getPasskey(id: string) { return clone(this.passkeys.get(id) ?? null); }
  async createPasskey(p: Passkey) { if (this.passkeys.has(p.id)) throw new Error('That passkey is already registered.'); this.passkeys.set(p.id, clone(p)); }
  async updatePasskey(id: string, p: Partial<Passkey>) { const k = this.passkeys.get(id); if (k) this.passkeys.set(id, { ...k, ...clone(p) }); }
  async deletePasskey(id: string) { this.passkeys.delete(id); }
  invites = new Map<string, Invite>();
  async createInvite(i: Invite) { this.invites.set(i.id, clone(i)); }
  async getInviteByHash(h: string) { return clone([...this.invites.values()].find(i => i.tokenHash === h) ?? null); }
  async listInvites(userId?: string) { return [...this.invites.values()].filter(i => !userId || i.userId === userId).map(clone); }
  async updateInvite(id: string, p: Partial<Invite>) { const i = this.invites.get(id); if (i) this.invites.set(id, { ...i, ...clone(p) }); }
  async putChallenge(c: PasskeyChallenge) { this.challenges.set(c.id, clone(c)); if (this.challenges.size > 2000) { const now = new Date().toISOString(); for (const [k, v] of this.challenges) if (v.expiresAt < now) this.challenges.delete(k); } }
  async takeChallenge(id: string) { const c = this.challenges.get(id) ?? null; this.challenges.delete(id); return clone(c); }
  async countRecentFailures(key: string, since: string) { return this.attempts.filter(a => a.key === key && !a.ok && a.at >= since).length; }
  async recordLoginAttempt(key: string, ok: boolean) { this.attempts.push({ key, ok, at: new Date().toISOString() }); if (this.attempts.length > 5000) this.attempts.splice(0, 1000); }
  async getSettings(scope = 'app') { return scope === 'app' ? clone(this.settings) : clone(this.scopedSettings.get(scope) ?? ({} as Settings)); }
  async putSettings(s: Settings, scope = 'app') { if (scope === 'app') this.settings = clone(s); else this.scopedSettings.set(scope, clone(s)); }
  async getSecret(n: string) { return this.secrets.get(n) ?? null; }
  async putSecret(n: string, v: string) { this.secrets.set(n, v); }

  async listDatasets() { return [...this.datasets.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async getDataset(id: string) { return clone(this.datasets.get(id) ?? null); }
  async createDataset(d: Dataset, bundle?: Uint8Array) { this.datasets.set(d.id, clone(d)); if (bundle) this.bundles.set(d.id, bundle); }
  async updateDataset(id: string, p: Partial<Dataset>) { const d = this.datasets.get(id); if (d) this.datasets.set(id, { ...d, ...clone(p) }); }
  async deleteDataset(id: string) { this.datasets.delete(id); this.bundles.delete(id); this.corpora.delete(id); }
  async getBundle(id: string) { return this.bundles.get(id) ?? null; }
  async putCorpus(id: string, c: Corpus) { this.corpora.set(id, c); }
  async getCorpus(id: string) { return this.corpora.get(id) ?? null; }

  async createRun(r: RunRecord) { this.runs.set(r.id, clone(r)); }
  async updateRun(id: string, p: Partial<RunRecord>) { const r = this.runs.get(id); if (r) this.runs.set(id, { ...r, ...clone(p) }); }
  async getRun(id: string, o?: { withResult?: boolean }) { const r = clone(this.runs.get(id) ?? null); if (r && o?.withResult === false) r.result = null; return r; }
  async listRuns(f: RunFilter) {
    return [...this.runs.values()].filter(r => (!f.status || f.status.includes(r.status)) && (!f.datasetId || r.datasetId === f.datasetId) && (!f.module || r.module === f.module) && (!f.requestedBy || r.requestedBy === f.requestedBy) && (!f.workspaceId || (r.workspaceId || 'ws_default') === f.workspaceId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, f.limit ?? 200).map(r => ({ ...clone(r), result: null, progress: null }));
  }
  async decide(runId: string, fn: (run: RunRecord) => Promise<{ decision: import('./model').DecisionRecord; status: RunRecord['status'] }>) {
    return this.lockOn('run:' + runId, async () => {
      const run = this.runs.get(runId); if (!run) throw new Error('Run not found.');
      const { decision, status } = await fn(clone(run));
      run.decisions.push(clone(decision)); run.status = status;
      return clone(run);
    });
  }

  sources = new Map<string, EvidenceSource>();
  async listSources() { return [...this.sources.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name)); }
  async getSource(id: string) { return clone(this.sources.get(id) ?? null); }
  async createSource(x: EvidenceSource) { this.sources.set(x.id, clone(x)); }
  async updateSource(id: string, p: Partial<EvidenceSource>) { const x = this.sources.get(id); if (x) this.sources.set(id, { ...x, ...clone(p) }); }
  async deleteSource(id: string) { this.sources.delete(id); }

  async listSchedules() { return [...this.schedules.values()].map(clone).sort((a, b) => a.name.localeCompare(b.name)); }
  async getSchedule(id: string) { return clone(this.schedules.get(id) ?? null); }
  async createSchedule(s: Schedule) { this.schedules.set(s.id, clone(s)); }
  async updateSchedule(id: string, p: Partial<Schedule>) { const s = this.schedules.get(id); if (s) this.schedules.set(id, { ...s, ...clone(p) }); }
  async deleteSchedule(id: string) { this.schedules.delete(id); }
  async claimDueSchedules(now: Date, fn: (s: Schedule) => Promise<Partial<Schedule>>) {
    return this.lockOn('schedules', async () => {
      let n = 0;
      for (const s of this.schedules.values()) {
        if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now.getTime()) continue;
        Object.assign(s, await fn(clone(s))); n++;
      }
      return n;
    });
  }

  async enqueue(j: Job) { this.jobs.set(j.id, clone(j)); }
  async claimJob(workerId: string) {
    return this.lockOn('jobs', async () => {
      const now = new Date().toISOString();
      const j = [...this.jobs.values()].filter(x => x.status === 'queued' && x.runAfter <= now).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!j) return null;
      Object.assign(j, { status: 'running', lockedBy: workerId, heartbeatAt: now, attempts: j.attempts + 1 }); return clone(j);
    });
  }
  async heartbeatJob(id: string) { const j = this.jobs.get(id); if (j) j.heartbeatAt = new Date().toISOString(); }
  async finishJob(id: string, ok: boolean, error?: string, retryInMs?: number) {
    const j = this.jobs.get(id); if (!j) return;
    if (ok) { j.status = 'done'; j.error = null; }
    else if (retryInMs !== undefined && j.attempts < j.maxAttempts) { j.status = 'queued'; j.error = error; j.runAfter = new Date(Date.now() + retryInMs).toISOString(); j.lockedBy = null; }
    else { j.status = 'failed'; j.error = error; }
  }
  async reapStaleJobs(older: string) {
    const out: Job[] = [];
    for (const j of this.jobs.values()) if (j.status === 'running' && (j.heartbeatAt ?? '') < older) { j.status = j.attempts < j.maxAttempts ? 'queued' : 'failed'; j.lockedBy = null; j.error = 'Worker stopped responding'; out.push(clone(j)); }
    return out;
  }
  async queueStats() { const s: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 }; for (const j of this.jobs.values()) s[j.status]++; return s; }

  async appendAudit(e: AuditEventInput) {
    return this.lockOn('audit', async () => {
      const prev = this.audit.at(-1);
      const base = { ...clone(e), seq: (prev?.seq ?? 0) + 1, at: new Date().toISOString(), prevHash: prev?.hash ?? 'GENESIS' };
      const ev: AuditEvent = { ...base, hash: await auditHash(base) };
      this.audit.push(ev); return clone(ev);
    });
  }
  async listAudit(o: { limit: number; beforeSeq?: number; workspaceId?: string }) { return this.audit.filter(e => (!o.beforeSeq || e.seq < o.beforeSeq) && (!o.workspaceId || ((e.details?.workspace as string) || 'ws_default') === o.workspaceId)).slice(-o.limit).reverse().map(clone); }
  async allAudit() { return this.audit.map(clone); }
  async ping() {}
}
