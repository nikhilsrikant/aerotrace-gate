// Domain model for the production gate: people, authority, datasets, runs, decisions and the audit log.
import type { AuditRun, DAL, Verdict, AuditOptions, A2AMessage, AgentHealth, Corpus, RunSummary } from '../engine/types';

export const PERMISSIONS = {
  'audit.view': 'See audits and their reports',
  'audit.request': 'Start audits',
  'schedule.manage': 'Create, edit, pause and run audit schedules',
  'dataset.manage': 'Upload and remove evidence datasets',
  'policy.manage': 'Edit approval policies (who can approve what)',
  'access.manage': 'Manage users, groups, roles and API tokens',
  'delegation.manage': "Create or revoke other people's delegations",
  'settings.manage': 'Change LLM, notification and organisation settings',
  'auditlog.view': 'Read and verify the audit log',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** A program (or customer) with its own datasets, audits, policies, groups, schedules, tokens and settings. */
export interface Workspace { id: string; name: string; slug: string; createdAt: string; createdBy: string; archived?: boolean }
export const DEFAULT_WORKSPACE = 'ws_default';
/** Records that belong to one workspace. Missing means the default workspace (data from before workspaces existed). */
export const wsOf = (x: { workspaceId?: string | null } | null | undefined) => x?.workspaceId || DEFAULT_WORKSPACE;

export interface User {
  id: string; email: string; name: string; active: boolean; provider: 'local' | 'oidc';
  /** roleIds: roles in the workspace being viewed (the storage layer maps this to/from workspaceRoles). */
  passwordHash?: string | null; roleIds: string[]; groupIds: string[];
  /** Roles per workspace. People are global; what they may do is per workspace. */
  workspaceRoles?: Record<string, string[]>;
  /** Can create workspaces and has every permission in every workspace. */
  platformAdmin?: boolean;
  createdAt: string; lastLoginAt?: string | null; mustChangePassword?: boolean;
  /** Bootstrap admins only: may enrol a first passkey straight after a password sign-in. Cleared once they have one. */
  allowPasswordEnrollment?: boolean;
}
export type PublicUser = Omit<User, 'passwordHash'>;
export interface Group { id: string; name: string; description: string; oidcName?: string | null; roleIds: string[]; createdAt: string; workspaceId?: string }
export interface Role { id: string; name: string; description: string; permissions: Permission[]; builtIn: boolean; createdAt: string }

export interface PolicyStep { id: string; name: string; groupIds: string[]; userIds: string[]; min: number }
export interface PolicyMatch { datasetIds: string[]; modules: string[]; dals: DAL[]; verdicts: Verdict[] }
export interface ApprovalPolicy {
  id: string; name: string; description: string; priority: number; active: boolean;
  match: PolicyMatch; steps: PolicyStep[]; sequential: boolean; allowSelfApproval: boolean; denyRequiresReason: boolean;
  version: number; updatedAt: string; updatedBy: string; workspaceId?: string;
}
export interface Delegation {
  id: string; fromUserId: string; toUserId: string; startsAt: string; endsAt: string; reason: string;
  createdBy: string; createdAt: string; revokedAt?: string | null; workspaceId?: string;
}
export interface ApiToken { id: string; name: string; userId: string; prefix: string; tokenHash: string; createdAt: string; lastUsedAt?: string | null; expiresAt?: string | null; revokedAt?: string | null; workspaceId?: string }
export interface Session {
  id: string; tokenHash: string; userId: string; createdAt: string; expiresAt: string; ip?: string; userAgent?: string;
  /** How this session was opened: password, SSO, or a passkey. */
  method?: 'password' | 'sso' | 'passkey' | 'invite';
  /** Last successful passkey check in this session, and which passkey. Data stays locked until this is set. */
  passkeyAt?: string | null; passkeyId?: string | null;
  /** The workspace this browser session is looking at. */
  workspaceId?: string | null;
}

/** A WebAuthn credential. The private key never leaves the person's device; we keep the public key. */
export interface Passkey {
  id: string;                 // credential ID, base64url
  userId: string; name: string;
  publicKey: string;          // COSE public key, base64url
  counter: number; transports: string[]; aaguid: string;
  deviceType: 'singleDevice' | 'multiDevice'; backedUp: boolean;
  createdAt: string; lastUsedAt?: string | null;
  /** True when the passkey came with a vendor attestation that chained to a pinned root. */
  attested?: boolean; model?: string | null;
}
/** One-time link that lets a new person (or someone whose passkeys were reset) set up a passkey. Replaces temporary passwords. */
export interface Invite { id: string; tokenHash: string; userId: string; createdBy: string; createdAt: string; expiresAt: string; usedAt?: string | null; revokedAt?: string | null }
export type ChallengePurpose = 'register' | 'login' | 'verify' | 'decision';
export interface PasskeyChallenge {
  id: string; purpose: ChallengePurpose; challenge: string; userId: string | null; sessionId: string | null;
  /** For decision challenges: exactly what the person is signing. */
  bind?: { runId: string; action: 'approve' | 'deny'; reportHash: string; reason: string | null; nonce: string } | null;
  expiresAt: string;
}
export const STEP_UP_ACTIONS = {
  'evidence.export': 'Download an evidence package or report',
  'policy.change': 'Change approval policies',
  'access.change': 'Change users, groups, roles or passkeys of others',
  'token.create': 'Create API tokens',
  'settings.change': 'Change organisation settings',
  'dataset.change': 'Upload or delete evidence datasets',
  'schedule.change': 'Create, edit or delete schedules',
  'delegation.change': 'Create delegations',
} as const;
export type StepUpAction = keyof typeof STEP_UP_ACTIONS;
export interface PasskeyPolicy {
  /** Nobody sees audit data until they have verified with a passkey in this session. */
  required: boolean;
  /** Sensitive actions need a passkey check this recent. */
  stepUpMinutes: number;
  stepUpFor: StepUpAction[];
  /** Approve and Deny are always signed by the approver's passkey when this is on. */
  signDecisions: boolean;
  /** How someone gets their first passkey: only via an invite link, invite or SSO sign-in, or any sign-in. */
  enrollment: 'invite' | 'invite_or_sso' | 'any';
  /** When non-empty, only these authenticator models (by AAGUID) can be enrolled, proven by vendor attestation. */
  allowedAuthenticators: { aaguid: string; name: string }[];
  /** PEM root certificates that attestation must chain to (for example the vendor's published attestation root). */
  attestationRoots: string[];
}
export const DEFAULT_PASSKEY_POLICY: PasskeyPolicy = {
  required: true, stepUpMinutes: 5, signDecisions: true, enrollment: 'invite_or_sso', allowedAuthenticators: [], attestationRoots: [],
  stepUpFor: ['evidence.export', 'policy.change', 'access.change', 'token.create', 'settings.change'],
};

export interface Settings {
  orgName: string;
  llm: { provider: 'none' | 'anthropic' | 'openai'; model: string; baseUrl: string };
  notifications: { slackUrl: string; teamsUrl: string; webhookUrl: string; events: string[] };
  retentionDays: number;
  dismissedSuggestions?: string[];
  passkeys?: PasskeyPolicy;
}
export const DEFAULT_SETTINGS: Settings = {
  orgName: 'Honeywell Aerospace',
  llm: { provider: 'none', model: 'claude-sonnet-5-5', baseUrl: '' },
  notifications: { slackUrl: '', teamsUrl: '', webhookUrl: '', events: ['run.awaiting_approval', 'run.approved', 'run.denied', 'run.failed'] },
  retentionDays: 3650,
  passkeys: DEFAULT_PASSKEY_POLICY,
};

export interface Dataset {
  id: string; name: string; program: string; baseline: string; source: 'synthetic' | 'bundle';
  status: 'importing' | 'ready' | 'failed'; seed?: number | null; total: number; counts: Record<string, number>;
  modules: { id: string; name: string; dal: DAL }[]; warnings: string[]; error?: string | null;
  createdBy: string; createdAt: string;
  /** Original uploaded bundle in object storage (kept for the record), and its SHA-256. */
  bundleUrl?: string | null; bundleKey?: string | null; bundleSha256?: string | null;
  /** Set when an evidence source produced this version: where every input came from. */
  provenance?: Provenance | null;
  workspaceId?: string;
}
export interface Provenance {
  sourceId: string; sourceName: string; fetchedAt: string; inputsSha256: string;
  git: { provider: string; repo: string; ref: string; commit: string; root: string; baselineRef?: string | null; baselineCommit?: string | null; baselineFrom: 'bundle' | 'ref' | 'none' };
  jira?: { baseUrl: string; jql: string; issues: number } | null;
  ci?: { kind: string; run?: string | null; artifact?: string | null; junitFiles: number; coverage: boolean } | null;
}

/** Where a program's evidence lives. Syncing it builds a bundle and records a new dataset version. Tokens are secret references only. */
export interface EvidenceSource {
  id: string; name: string; workspaceId?: string;
  git: { provider: 'github' | 'gitlab'; baseUrl?: string; repo: string; ref: string; root?: string; baselineRef?: string; tokenRef?: string };
  jira?: { baseUrl: string; deployment: 'cloud' | 'server'; jql: string; auth: 'basic' | 'bearer'; email?: string; tokenRef: string;
    moduleField?: string; filesField?: string } | null;
  ci?: { kind: 'github-actions' | 'gitlab' | 'urls'; workflow?: string; artifact?: string; job?: string; junitUrls?: string[]; coverageUrl?: string; tokenRef?: string } | null;
  /** Audit these modules after every sync that produces new evidence. */
  autoAudit?: { modules: string[]; layer2: 'auto' | 'llm' | 'heuristic' } | null;
  lastSync?: { at: string; status: 'ok' | 'unchanged' | 'failed'; datasetId?: string | null; commit?: string | null; inputsSha256?: string | null; error?: string | null; runIds?: string[] } | null;
  createdBy: string; createdAt: string; updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'failed' | 'awaiting_approval' | 'approved' | 'denied';
export interface RunProgress { phase: string; messages: A2AMessage[]; health: AgentHealth[]; updatedAt: string }
export interface PolicySnapshot { policy: ApprovalPolicy | null; matchedAt: string; reason: string }
export interface Signature { alg: 'Ed25519' | 'ES256' | 'HS256'; keyId: string; value: string }
export interface DecisionRecord {
  id: string; runId: string; stepId: string; stepName: string; action: 'approve' | 'deny';
  userId: string; userName: string; onBehalfOf?: { id: string; name: string } | null; reason?: string | null;
  at: string; reportHash: string; signature: Signature;
  /** The approver's own passkey signature over this decision (WebAuthn assertion), verifiable with their public key. */
  passkey?: PasskeyProof | null;
}
export interface PasskeyProof {
  credentialId: string; publicKey: string; challenge: string; nonce: string; rpId: string; origin: string;
  authenticatorData: string; clientDataJSON: string; signature: string; userVerified: boolean; verifiedAt: string;
}
export interface RunRecord {
  id: string; datasetId: string; datasetName: string; program: string; baseline: string;
  module: string; moduleName: string; dal: DAL; status: RunStatus; verdict?: Verdict | null; verdictReason?: string | null;
  options: AuditOptions; requestedBy: string; requestedByName: string; createdAt: string;
  startedAt?: string | null; finishedAt?: string | null; error?: string | null; attempts: number;
  progress?: RunProgress | null; result?: AuditRun | null; policy?: PolicySnapshot | null; decisions: DecisionRecord[];
  reportHash?: string | null; trigger: 'manual' | 'schedule' | 'api'; scheduleId?: string | null; summary?: RunSummary | null;
  workspaceId?: string;
}

export type Recurrence =
  | { kind: 'interval'; everyMinutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'cron'; expr: string };
export interface Schedule {
  id: string; name: string; datasetId: string; modules: string[]; layer2: 'auto' | 'llm' | 'heuristic';
  recurrence: Recurrence; timezone: string; enabled: boolean; skipIfPending: boolean; notifyOn: ('NO' | 'CONDITIONAL' | 'YES' | 'failed')[];
  ownerId: string; ownerName: string; nextRunAt: string | null; lastRunAt?: string | null; lastRunIds?: string[]; lastError?: string | null;
  createdAt: string; updatedAt: string; workspaceId?: string;
  /** Sync this evidence source first, then audit the version it produces. */
  sourceId?: string | null;
}

export interface Job { id: string; kind: 'audit' | 'import' | 'sync'; payload: Record<string, unknown>; status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number; maxAttempts: number; runAfter: string; lockedBy?: string | null; heartbeatAt?: string | null; error?: string | null; createdAt: string }

export interface AuditEvent {
  seq: number; at: string; actorId: string; actorName: string; action: string; target: string;
  details: Record<string, unknown>; prevHash: string; hash: string;
}
export type AuditEventInput = Omit<AuditEvent, 'seq' | 'at' | 'prevHash' | 'hash'>;

export interface Actor {
  user: PublicUser; permissions: Set<Permission>; via: 'session' | 'token' | 'local';
  /** Present for browser sessions. passkeyAt is the last passkey check in this session. */
  session?: { id: string; method: Session['method']; passkeyAt: string | null; passkeyId: string | null } | null;
  /** The workspace this actor is acting in, and whether they are a platform administrator. */
  workspaceId?: string; platformAdmin?: boolean;
}
export type CorpusLoader = (d: Dataset) => Promise<Corpus>;
