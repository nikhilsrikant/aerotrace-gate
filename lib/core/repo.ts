// Storage contract. PgRepo (production) and MemRepo (tests, browser demo) both implement it.
import type {
  User, Group, Role, ApprovalPolicy, Workspace, Delegation, ApiToken, Session, Settings, Passkey, PasskeyChallenge, Invite, EvidenceSource, Dataset, RunRecord, DecisionRecord,
  Job, AuditEvent, AuditEventInput, Schedule, RunStatus,
} from './model';
import type { Corpus } from '../engine/types';

export interface RunFilter { status?: RunStatus[]; datasetId?: string; module?: string; limit?: number; requestedBy?: string; workspaceId?: string }
export interface Repo {
  kind: 'postgres' | 'memory';
  // workspaces
  listWorkspaces(): Promise<Workspace[]>; createWorkspace(w: Workspace): Promise<void>; updateWorkspace(id: string, patch: Partial<Workspace>): Promise<void>;
  // people and authority
  listUsers(): Promise<User[]>; getUser(id: string): Promise<User | null>; getUserByEmail(email: string): Promise<User | null>;
  createUser(u: User): Promise<void>; updateUser(id: string, patch: Partial<User>): Promise<void>;
  listGroups(): Promise<Group[]>; createGroup(g: Group): Promise<void>; updateGroup(id: string, patch: Partial<Group>): Promise<void>; deleteGroup(id: string): Promise<void>;
  listRoles(): Promise<Role[]>; createRole(r: Role): Promise<void>; updateRole(id: string, patch: Partial<Role>): Promise<void>; deleteRole(id: string): Promise<void>;
  listPolicies(): Promise<ApprovalPolicy[]>; createPolicy(p: ApprovalPolicy): Promise<void>; updatePolicy(id: string, p: ApprovalPolicy): Promise<void>; deletePolicy(id: string): Promise<void>;
  listDelegations(): Promise<Delegation[]>; createDelegation(d: Delegation): Promise<void>; updateDelegation(id: string, patch: Partial<Delegation>): Promise<void>;
  listTokens(): Promise<ApiToken[]>; createToken(t: ApiToken): Promise<void>; getTokenByHash(h: string): Promise<ApiToken | null>; updateToken(id: string, patch: Partial<ApiToken>): Promise<void>;
  createSession(s: Session): Promise<void>; getSessionByHash(h: string): Promise<Session | null>; deleteSession(id: string): Promise<void>; deleteUserSessions(userId: string): Promise<void>;
  updateSession(id: string, patch: Partial<Session>): Promise<void>;
  // passkeys
  listPasskeys(userId?: string): Promise<Passkey[]>; getPasskey(id: string): Promise<Passkey | null>; createPasskey(p: Passkey): Promise<void>;
  updatePasskey(id: string, patch: Partial<Passkey>): Promise<void>; deletePasskey(id: string): Promise<void>;
  createInvite(i: Invite): Promise<void>; getInviteByHash(h: string): Promise<Invite | null>; listInvites(userId?: string): Promise<Invite[]>; updateInvite(id: string, patch: Partial<Invite>): Promise<void>;
  putChallenge(c: PasskeyChallenge): Promise<void>;
  /** Returns the challenge and deletes it, so each one can be answered once. */
  takeChallenge(id: string): Promise<PasskeyChallenge | null>;
  countRecentFailures(key: string, sinceIso: string): Promise<number>; recordLoginAttempt(key: string, ok: boolean): Promise<void>;
  /** scope: 'app' (organisation-wide, the default) or 'ws:<workspaceId>'. */
  getSettings(scope?: string): Promise<Settings>; putSettings(s: Settings, scope?: string): Promise<void>;
  getSecret(name: string): Promise<string | null>; putSecret(name: string, value: string): Promise<void>;
  // evidence
  listDatasets(): Promise<Dataset[]>; getDataset(id: string): Promise<Dataset | null>;
  createDataset(d: Dataset, bundle?: Uint8Array): Promise<void>; updateDataset(id: string, patch: Partial<Dataset>): Promise<void>; deleteDataset(id: string): Promise<void>;
  getBundle(id: string): Promise<Uint8Array | null>; putCorpus(id: string, c: Corpus): Promise<void>; getCorpus(id: string): Promise<Corpus | null>;
  listSources(): Promise<EvidenceSource[]>; getSource(id: string): Promise<EvidenceSource | null>; createSource(s: EvidenceSource): Promise<void>;
  updateSource(id: string, patch: Partial<EvidenceSource>): Promise<void>; deleteSource(id: string): Promise<void>;
  // runs
  createRun(r: RunRecord): Promise<void>; updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  getRun(id: string, opts?: { withResult?: boolean }): Promise<RunRecord | null>; listRuns(f: RunFilter): Promise<RunRecord[]>;
  /** Locks the run row, lets fn decide, then stores the decision and new status atomically. */
  decide(runId: string, fn: (run: RunRecord) => Promise<{ decision: DecisionRecord; status: RunStatus }>): Promise<RunRecord>;
  // schedules
  listSchedules(): Promise<Schedule[]>; getSchedule(id: string): Promise<Schedule | null>; createSchedule(s: Schedule): Promise<void>;
  updateSchedule(id: string, patch: Partial<Schedule>): Promise<void>; deleteSchedule(id: string): Promise<void>;
  /** Claims every enabled schedule due at `now` (no two workers get the same one) and hands each to fn. */
  claimDueSchedules(now: Date, fn: (s: Schedule) => Promise<Partial<Schedule>>): Promise<number>;
  // jobs
  enqueue(j: Job): Promise<void>; claimJob(workerId: string): Promise<Job | null>; heartbeatJob(id: string): Promise<void>;
  finishJob(id: string, ok: boolean, error?: string, retryInMs?: number): Promise<void>; reapStaleJobs(olderThanIso: string): Promise<Job[]>;
  queueStats(): Promise<Record<string, number>>;
  // audit log (append-only, hash-chained)
  appendAudit(e: AuditEventInput): Promise<AuditEvent>; listAudit(opts: { limit: number; beforeSeq?: number; workspaceId?: string }): Promise<AuditEvent[]>;
  allAudit(): Promise<AuditEvent[]>;
  ping(): Promise<void>;
}
