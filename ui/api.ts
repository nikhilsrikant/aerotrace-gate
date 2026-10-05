// What the UI needs from a backend. httpApi talks to the server; localApi runs the same services in the browser.
import type { Workspace, PublicUser, Permission, Dataset, Schedule, ApprovalPolicy, Delegation, Group, Role, Settings, AuditEvent, ApiToken, Recurrence, RunRecord, EvidenceSource } from '../lib/core/model';
import type { RunView } from '../lib/core/services';
import type { Answer } from '../lib/core/assistant';
import type { ProgramOverview } from '../lib/core/program';
import type { ChaosPreset } from '../lib/core/chaos';
export type { ProgramOverview, ChaosPreset };
export type { Answer };
import type { AuditOptions, AgentName, Fault, DAL, Verdict } from '../lib/engine/types';

export interface Assurance { canEnroll?: boolean; enrollment?: string; hardwareOnly?: boolean; allowedAuthenticators?: string[]; required: boolean; verified: boolean; verifiedAt: string | null; stepUpUntil: string | null; stepUpMinutes: number; stepUpFor: string[]; signDecisions: boolean; passkeys: number; method: string | null; passkeyId?: string | null }
export interface Me { user: PublicUser; permissions: Permission[]; mustChangePassword?: boolean; assurance?: Assurance }
export interface PasskeyInfo { id: string; userId: string; name: string; transports: string[]; aaguid: string; deviceType: 'singleDevice' | 'multiDevice'; backedUp: boolean; createdAt: string; lastUsedAt?: string | null; attested?: boolean; model?: string | null }
export interface InviteLink { token: string; url: string; expiresAt: string; email: string; name: string }
/** Errors carry the server's machine-readable code, e.g. step_up_required. */
export class ApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export interface Meta {
  version: string; orgName: string; llm: { provider: string; model: string; configured: boolean }; store: string;
  signer: { alg: string; keyId: string }; permissions: { id: Permission; label: string }[]; sso: boolean; voice?: { serverStt: boolean };
  stepUpActions?: { id: string; label: string }[];
  workspace?: { id: string; name: string }; workspaces?: Workspace[]; platformAdmin?: boolean;
}
export interface Directory { users: { id: string; name: string; email: string }[]; groups: { id: string; name: string }[] }
export type FullRun = RunView & Pick<RunRecord, 'result' | 'progress'>;
export interface Check { name: string; ok: boolean; detail: string }
export interface Diff { previous: { id: string; createdAt: string; verdict?: Verdict | null; status: string } | null; added: { severity: number; title: string; agent: AgentName }[]; resolved: { severity: number; title: string; agent: AgentName }[]; unchanged: number }
export type ScheduleView = Schedule & { description: string };
export interface StartInput { datasetId: string; modules: string[]; layer2: AuditOptions['layer2']; faults: Partial<Record<AgentName, Fault>> }
export type ScheduleInput = { id?: string; name: string; datasetId: string; sourceId?: string | null; modules: string[]; layer2: AuditOptions['layer2']; recurrence: Recurrence; timezone: string; enabled: boolean; skipIfPending: boolean; notifyOn: Schedule['notifyOn'] };
export type SourceInput = Pick<EvidenceSource, 'name' | 'git' | 'jira' | 'ci' | 'autoAudit'> & { id?: string };
export type SyncOutcome = { queued: true } | { status: 'ok' | 'unchanged'; datasetId: string; commit: string; runIds: string[]; warnings: string[] };
export type SourceTest = { ok: false; error: string } | { ok: true; commit: string; program: string; baseline: string; modules: string[]; total: number; bytes: number; unchanged: boolean; warnings: string[] };
export type PolicyInput = Omit<ApprovalPolicy, 'version' | 'updatedAt' | 'updatedBy' | 'id'> & { id?: string };
export interface Simulation { policy: { id: string; name: string; version: number } | null; waitingOn: string; steps: { name: string; min: number; eligible: string[] }[] }

export interface Suggestion { key: string; datasetId: string; datasetName: string; module: string; count: number; everyHours: number; lastAt: string; recurrence: Recurrence; timezone: string; description: string; runIds: string[] }
export interface Api {
  mode: 'server' | 'browser';
  authConfig(): Promise<{ local: boolean; sso: { label: string } | null; version: string }>;
  me(): Promise<Me | null>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  ssoUrl(): string | null;
  // passkeys: each call runs the whole ceremony (server challenge, device prompt, verification)
  passkeyLogin(): Promise<void>;
  enrollPasskey(name?: string): Promise<PasskeyInfo>;
  verifyPasskey(): Promise<void>;
  passkeys(): Promise<PasskeyInfo[]>;
  renamePasskey(id: string, name: string): Promise<void>;
  removePasskey(id: string): Promise<void>;
  resetPasskeys(userId: string): Promise<{ removed: number; invite: InviteLink }>;
  createInvite(userId: string, hours?: number): Promise<InviteLink>;
  redeemInvite(token: string): Promise<void>;
  /** Authenticated download that surfaces step-up errors instead of a blank page. */
  fetchFile?(url: string): Promise<Blob>;
  demoUsers?(): Promise<{ id: string; name: string; summary: string }[]>;
  switchUser?(id: string): Promise<void>;

  meta(): Promise<Meta>;
  directory(): Promise<Directory>;
  datasets(): Promise<Dataset[]>;
  uploadDataset(name: string, file: File): Promise<Dataset>;
  createSynthetic(name: string, seed: number): Promise<Dataset>;
  deleteDataset(id: string): Promise<void>;
  sources(): Promise<EvidenceSource[]>;
  saveSource(s: SourceInput): Promise<EvidenceSource>;
  deleteSource(id: string): Promise<void>;
  syncSource(id: string): Promise<SyncOutcome>;
  testSource(id: string): Promise<SourceTest>;
  sampleUrl(): string | null;

  runs(status?: string[]): Promise<RunView[]>;
  inbox(): Promise<{ mine: RunView[]; others: RunView[] }>;
  run(id: string): Promise<FullRun>;
  startAudits(i: StartInput): Promise<{ runIds: string[] }>;
  decide(id: string, action: 'approve' | 'deny', reason?: string): Promise<FullRun>;
  verify(id: string): Promise<{ ok: boolean; checks: Check[] }>;
  diff(id: string): Promise<Diff | null>;
  reportUrl(id: string): string | null;
  evidenceUrl(id: string): string | null;
  evidence(id: string): Promise<unknown>;

  schedules(): Promise<ScheduleView[]>;
  saveSchedule(s: ScheduleInput): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  runSchedule(id: string): Promise<{ runIds: string[] }>;

  policies(): Promise<ApprovalPolicy[]>;
  savePolicy(p: PolicyInput): Promise<ApprovalPolicy>;
  deletePolicy(id: string): Promise<void>;
  simulate(f: { datasetId: string; module: string; dal: DAL; verdict: Verdict; requestedBy: string }): Promise<Simulation>;
  delegations(): Promise<Delegation[]>;
  createDelegation(d: { fromUserId?: string; toUserId: string; startsAt: string; endsAt: string; reason: string }): Promise<Delegation>;
  revokeDelegation(id: string): Promise<void>;

  users(): Promise<(PublicUser & { passkeys?: number })[]>;
  createUser(i: { email: string; name: string; password?: string; roleIds: string[]; groupIds: string[] }): Promise<PublicUser>;
  updateUser(id: string, p: { name?: string; active?: boolean; roleIds?: string[]; groupIds?: string[]; password?: string }): Promise<void>;
  groups(): Promise<Group[]>;
  saveGroup(g: Partial<Group> & { name: string }, memberIds: string[]): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  roles(): Promise<{ roles: Role[]; permissions: { id: Permission; label: string }[] }>;
  saveRole(r: Partial<Role> & { name: string; permissions: Permission[] }): Promise<void>;
  deleteRole(id: string): Promise<void>;
  tokens(): Promise<Omit<ApiToken, 'tokenHash'>[]>;
  createToken(i: { name: string; userId?: string; expiresInDays: number }): Promise<{ token: string; expiresAt: string }>;
  revokeToken(id: string): Promise<void>;
  settings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  workspaces(): Promise<{ current: string; platformAdmin: boolean; workspaces: Workspace[] }>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<void>;
  switchWorkspace(id: string): Promise<void>;
  program(datasetId?: string): Promise<ProgramOverview>;
  chaosDrill(module: string, preset: ChaosPreset, datasetId?: string): Promise<{ runId: string }>;
  ask(question: string, runId?: string): Promise<Answer>;
  transcribe?(audio: Blob): Promise<string>;
  suggestions(): Promise<Suggestion[]>;
  dismissSuggestion(key: string): Promise<void>;
  auditLog(limit: number, before?: number): Promise<AuditEvent[]>;
  verifyAuditLog(): Promise<{ ok: boolean; checked: number; brokenAt?: number; reason?: string }>;
}
