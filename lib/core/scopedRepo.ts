// A workspace's view of the store. Everything the services read or write goes through it, so one workspace can never
// see another's datasets, evidence sources, audits, policies, groups, schedules, tokens, delegations, settings or audit-log entries.
// Lists are filtered, creates are stamped, and reading or changing a record from another workspace behaves as "not found".
// Global things pass straight through: people (with their roles mapped to this workspace), sessions, passkeys, roles,
// secrets, jobs, and the single hash-chained audit log (entries are tagged with the workspace).
import type { Repo, RunFilter } from './repo';
import type { User, Group, ApprovalPolicy, Delegation, ApiToken, Dataset, EvidenceSource, RunRecord, Schedule, Settings, AuditEventInput } from './model';
import { DEFAULT_WORKSPACE, wsOf } from './model';

export function scopedRepo(base: Repo, ws: string): Repo {
  const mine = <T extends { workspaceId?: string | null }>(x: T | null) => (x && wsOf(x) === ws ? x : null);
  const stamp = <T extends object>(x: T): T => ({ ...x, workspaceId: ws });
  const groupIds = async () => new Set((await base.listGroups()).filter(g => wsOf(g) === ws).map(g => g.id));
  const rolesIn = (u: User) => u.workspaceRoles?.[ws] ?? (ws === DEFAULT_WORKSPACE && !u.workspaceRoles ? u.roleIds : []);
  const view = (u: User, g: Set<string>): User => ({ ...u, roleIds: rolesIn(u), groupIds: u.groupIds.filter(id => g.has(id)) });
  const isMember = (u: User, g: Set<string>) => !!u.platformAdmin || rolesIn(u).length > 0 || u.groupIds.some(id => g.has(id)) || ws in (u.workspaceRoles ?? {});
  const guard = async <T extends { workspaceId?: string | null }>(get: () => Promise<T | null>, what: string) => { if (!mine(await get())) throw new Error(`${what} not found in this workspace.`); };

  const overrides: Partial<Repo> = {
    // people: global identities, roles and groups shown for this workspace only
    async listUsers() { const g = await groupIds(); return (await base.listUsers()).filter(u => isMember(u, g)).map(u => view(u, g)); },
    async getUser(id) { const u = await base.getUser(id); return u ? view(u, await groupIds()) : null; },
    async getUserByEmail(e) { const u = await base.getUserByEmail(e); return u ? view(u, await groupIds()) : null; },
    async createUser(u) { await base.createUser({ ...u, workspaceRoles: { [ws]: u.roleIds }, roleIds: ws === DEFAULT_WORKSPACE ? u.roleIds : [] }); },
    async updateUser(id, p) {
      const raw = await base.getUser(id); if (!raw) return;
      const { roleIds, groupIds: gids, ...rest } = p; const patch: Partial<User> = { ...rest };
      if (roleIds) { patch.workspaceRoles = { ...(raw.workspaceRoles ?? (raw.roleIds?.length ? { [DEFAULT_WORKSPACE]: raw.roleIds } : {})), [ws]: roleIds }; if (ws === DEFAULT_WORKSPACE) patch.roleIds = roleIds; }
      if (gids) { const g = await groupIds(); patch.groupIds = [...raw.groupIds.filter(x => !g.has(x)), ...gids.filter(x => g.has(x))]; }
      await base.updateUser(id, patch);
    },
    // groups
    async listGroups() { return (await base.listGroups()).filter(g => wsOf(g) === ws); },
    async createGroup(g: Group) { if ((await base.listGroups()).some(x => wsOf(x) === ws && x.name.toLowerCase() === g.name.toLowerCase())) throw new Error(`A group named ${g.name} already exists.`); await base.createGroup(stamp(g)); },
    async updateGroup(id, p) { await guard(async () => (await base.listGroups()).find(g => g.id === id) ?? null, 'Group'); await base.updateGroup(id, { ...p, workspaceId: ws }); },
    async deleteGroup(id) { await guard(async () => (await base.listGroups()).find(g => g.id === id) ?? null, 'Group'); await base.deleteGroup(id); },
    // approval policies, delegations, tokens
    async listPolicies() { return (await base.listPolicies()).filter(x => wsOf(x) === ws); },
    async createPolicy(p: ApprovalPolicy) { await base.createPolicy(stamp(p)); },
    async updatePolicy(id, p) { await guard(async () => (await base.listPolicies()).find(x => x.id === id) ?? null, 'Policy'); await base.updatePolicy(id, stamp(p)); },
    async deletePolicy(id) { await guard(async () => (await base.listPolicies()).find(x => x.id === id) ?? null, 'Policy'); await base.deletePolicy(id); },
    async listDelegations() { return (await base.listDelegations()).filter(x => wsOf(x) === ws); },
    async createDelegation(d: Delegation) { await base.createDelegation(stamp(d)); },
    async updateDelegation(id, p) { await guard(async () => (await base.listDelegations()).find(x => x.id === id) ?? null, 'Delegation'); await base.updateDelegation(id, p); },
    async listTokens() { return (await base.listTokens()).filter(x => wsOf(x) === ws); },
    async createToken(t: ApiToken) { await base.createToken(stamp(t)); },
    async getTokenByHash(h) { return mine(await base.getTokenByHash(h)); },
    async updateToken(id, p) { await guard(async () => (await base.listTokens()).find(x => x.id === id) ?? null, 'Token'); await base.updateToken(id, p); },
    // evidence
    async listDatasets() { return (await base.listDatasets()).filter(x => wsOf(x) === ws); },
    async getDataset(id) { return mine(await base.getDataset(id)); },
    async createDataset(d: Dataset, bundle?: Uint8Array) { await base.createDataset(stamp(d), bundle); },
    async updateDataset(id, p) { await guard(() => base.getDataset(id), 'Dataset'); await base.updateDataset(id, p); },
    async deleteDataset(id) { await guard(() => base.getDataset(id), 'Dataset'); await base.deleteDataset(id); },
    async getBundle(id) { return mine(await base.getDataset(id)) ? base.getBundle(id) : null; },
    async getCorpus(id) { return mine(await base.getDataset(id)) ? base.getCorpus(id) : null; },
    async putCorpus(id, c) { await guard(() => base.getDataset(id), 'Dataset'); await base.putCorpus(id, c); },
    async listSources() { return (await base.listSources()).filter(x => wsOf(x) === ws); },
    async getSource(id) { return mine(await base.getSource(id)); },
    async createSource(x: EvidenceSource) { await base.createSource(stamp(x)); },
    async updateSource(id, p) { await guard(() => base.getSource(id), 'Evidence source'); await base.updateSource(id, { ...p, workspaceId: ws }); },
    async deleteSource(id) { await guard(() => base.getSource(id), 'Evidence source'); await base.deleteSource(id); },
    // audits
    async createRun(r: RunRecord) { await base.createRun(stamp(r)); },
    async getRun(id, o) { return mine(await base.getRun(id, o)); },
    async listRuns(f: RunFilter) { return base.listRuns({ ...f, workspaceId: ws }); },
    async updateRun(id, p) { await guard(() => base.getRun(id, { withResult: false }), 'Audit'); await base.updateRun(id, p); },
    async decide(id, fn) { await guard(() => base.getRun(id, { withResult: false }), 'Audit'); return base.decide(id, fn); },
    // schedules
    async listSchedules() { return (await base.listSchedules()).filter(x => wsOf(x) === ws); },
    async getSchedule(id) { return mine(await base.getSchedule(id)); },
    async createSchedule(s: Schedule) { await base.createSchedule(stamp(s)); },
    async updateSchedule(id, p) { await guard(() => base.getSchedule(id), 'Schedule'); await base.updateSchedule(id, p); },
    async deleteSchedule(id) { await guard(() => base.getSchedule(id), 'Schedule'); await base.deleteSchedule(id); },
    // settings: organisation-wide (passkey policy) plus this workspace's own (name, notifications, LLM, ...)
    async getSettings(scope?: string) {
      if (scope && scope !== 'app') return base.getSettings(scope);
      const org = await base.getSettings('app'); const mineS = await base.getSettings(`ws:${ws}`);
      return { ...org, ...mineS, passkeys: org.passkeys } as Settings;
    },
    async putSettings(s: Settings, scope?: string) {
      if (scope && scope !== 'app') return base.putSettings(s, scope);
      const { passkeys, ...rest } = s; const org = await base.getSettings('app');
      await base.putSettings(rest as Settings, `ws:${ws}`);
      if (passkeys && JSON.stringify(passkeys) !== JSON.stringify(org.passkeys)) await base.putSettings({ ...org, passkeys }, 'app');
    },
    // audit log: one chain for everyone, each entry tagged with its workspace
    async appendAudit(e: AuditEventInput) { return base.appendAudit({ ...e, details: { ...e.details, workspace: ws } }); },
    async listAudit(o) { return base.listAudit({ ...o, workspaceId: ws }); },
  };
  return new Proxy(base, { get(t, p, r) { if (p in overrides) return (overrides as Record<string | symbol, unknown>)[p]; const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v; } }) as Repo;
}
