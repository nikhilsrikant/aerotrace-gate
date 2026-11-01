// Postgres implementation of the Repo contract. Row locks and SKIP LOCKED make it safe with many web and worker replicas.
import pg from 'pg';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Repo, RunFilter } from '../core/repo';
import type { User, Group, Role, ApprovalPolicy, Delegation, ApiToken, Session, Settings, Passkey, PasskeyChallenge, Invite, Workspace, EvidenceSource, Dataset, RunRecord, DecisionRecord, Job, AuditEvent, AuditEventInput, Schedule, RunStatus } from '../core/model';
import { DEFAULT_SETTINGS } from '../core/model';
import type { Corpus, AuditRun } from '../engine/types';
import { auditHash } from '../core/auditHash';
import { MIGRATIONS } from './migrations';
import { createHash } from 'node:crypto';
import { telemetry } from '../engine/telemetry';
import { blobStoreFromEnv, type BlobStore } from './cloud/blob';

const zip = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v)));
const unzip = <T,>(b: Buffer | null): T | null => (b ? JSON.parse(gunzipSync(b).toString()) as T : null);
const isoOf = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

export class PgRepo implements Repo {
  kind = 'postgres' as const;
  /** Where uploaded evidence bundles go. null: in the datasets table (the default). */
  constructor(public pool: pg.Pool, public blobs: Promise<BlobStore | null> = Promise.resolve(null)) {}
  static fromEnv() {
    // Like libpq: require = encrypted; verify-full = encrypted and the server certificate checked (DATABASE_CA_CERT for RDS / Cloud SQL / Azure CAs).
    const mode = (process.env.DATABASE_SSL || 'disable').toLowerCase();
    const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n');
    const ssl = mode === 'verify-full' || mode === 'verify-ca' ? { rejectUnauthorized: true, ...(ca ? { ca } : {}), ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}) }
      : mode === 'require' ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' || !!ca, ...(ca ? { ca } : {}) } : undefined;
    return new PgRepo(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_MAX || 10), ssl, application_name: process.env.AEROTRACE_ROLE || 'aerotrace' }), blobStoreFromEnv());
  }
  private q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
    // One span per query; the statement is recorded without values.
    const op = text.trim().split(/\s+/)[0].toUpperCase(); const table = /(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/i.exec(text)?.[1];
    return telemetry.span(`db ${op}${table ? ' ' + table : ''}`, { 'db.system': 'postgresql', 'db.operation': op, 'db.sql.table': table, 'db.statement': text.replace(/\s+/g, ' ').slice(0, 300) }, () => this.pool.query<T>(text, values));
  }
  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async migrate(log: (m: string) => void = () => {}) {
    await this.q('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    await this.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(424242)');
      const done = new Set((await c.query<{ version: number }>('SELECT version FROM schema_migrations')).rows.map(r => r.version));
      for (const m of MIGRATIONS) if (!done.has(m.version)) { log(`applying migration ${m.version}: ${m.name}`); await c.query(m.sql); await c.query('INSERT INTO schema_migrations (version, name) VALUES ($1,$2)', [m.version, m.name]); }
    });
  }
  async ping() { await this.q('SELECT 1'); }

  // generic jsonb tables
  private async all<T>(table: string): Promise<T[]> { return (await this.q<{ data: T }>(`SELECT data FROM ${table}`)).rows.map(r => r.data); }
  private async one<T>(table: string, id: string): Promise<T | null> { return (await this.q<{ data: T }>(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data ?? null; }
  private async merge(table: string, id: string, patch: object) { await this.q(`UPDATE ${table} SET data = data || $2::jsonb WHERE id=$1`, [id, JSON.stringify(patch)]); }

  listUsers() { return this.all<User>('users'); }
  getUser(id: string) { return this.one<User>('users', id); }
  async getUserByEmail(e: string) { return (await this.q<{ data: User }>('SELECT data FROM users WHERE lower(email)=lower($1)', [e])).rows[0]?.data ?? null; }
  async createUser(u: User) {
    try { await this.q('INSERT INTO users (id, email, data) VALUES ($1,$2,$3)', [u.id, u.email, u]); }
    catch (e) { if ((e as { code?: string }).code === '23505') throw new Error(`A user with email ${u.email} already exists.`); throw e; }
  }
  updateUser(id: string, p: Partial<User>) { return this.merge('users', id, p); }
  listGroups() { return this.all<Group>('groups'); }
  async createGroup(g: Group) {
    try { await this.q('INSERT INTO groups (id, data) VALUES ($1,$2)', [g.id, g]); }
    catch (e) { if ((e as { code?: string }).code === '23505') throw new Error(`A group named ${g.name} already exists.`); throw e; }
  }
  updateGroup(id: string, p: Partial<Group>) { return this.merge('groups', id, p); }
  async deleteGroup(id: string) { await this.tx(async c => { await c.query('DELETE FROM groups WHERE id=$1', [id]); await c.query(`UPDATE users SET data = jsonb_set(data, '{groupIds}', COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(data->'groupIds') x WHERE x <> to_jsonb($1::text)), '[]'::jsonb)) WHERE data->'groupIds' ? $1`, [id]); }); }
  listRoles() { return this.all<Role>('roles'); }
  async createRole(r: Role) { await this.q('INSERT INTO roles (id, data) VALUES ($1,$2)', [r.id, r]); }
  updateRole(id: string, p: Partial<Role>) { return this.merge('roles', id, p); }
  async deleteRole(id: string) {
    await this.tx(async c => {
      await c.query('DELETE FROM roles WHERE id=$1', [id]);
      for (const t of ['users', 'groups']) await c.query(`UPDATE ${t} SET data = jsonb_set(data, '{roleIds}', COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(data->'roleIds') x WHERE x <> to_jsonb($1::text)), '[]'::jsonb)) WHERE data->'roleIds' ? $1`, [id]);
    });
  }
  listPolicies() { return this.all<ApprovalPolicy>('policies'); }
  async createPolicy(p: ApprovalPolicy) { await this.q('INSERT INTO policies (id, data) VALUES ($1,$2)', [p.id, p]); }
  async updatePolicy(id: string, p: ApprovalPolicy) { await this.q('UPDATE policies SET data=$2 WHERE id=$1', [id, p]); }
  async deletePolicy(id: string) { await this.q('DELETE FROM policies WHERE id=$1', [id]); }
  listDelegations() { return this.all<Delegation>('delegations'); }
  async createDelegation(d: Delegation) { await this.q('INSERT INTO delegations (id, data) VALUES ($1,$2)', [d.id, d]); }
  updateDelegation(id: string, p: Partial<Delegation>) { return this.merge('delegations', id, p); }
  listTokens() { return this.all<ApiToken>('api_tokens'); }
  async createToken(t: ApiToken) { await this.q('INSERT INTO api_tokens (id, token_hash, data) VALUES ($1,$2,$3)', [t.id, t.tokenHash, t]); }
  async getTokenByHash(h: string) { return (await this.q<{ data: ApiToken }>('SELECT data FROM api_tokens WHERE token_hash=$1', [h])).rows[0]?.data ?? null; }
  updateToken(id: string, p: Partial<ApiToken>) { return this.merge('api_tokens', id, p); }
  async createSession(s: Session) { await this.q('INSERT INTO sessions (id, token_hash, user_id, expires_at, data) VALUES ($1,$2,$3,$4,$5)', [s.id, s.tokenHash, s.userId, s.expiresAt, s]); }
  async getSessionByHash(h: string) { return (await this.q<{ data: Session }>('SELECT data FROM sessions WHERE token_hash=$1 AND expires_at > now()', [h])).rows[0]?.data ?? null; }
  async deleteSession(id: string) { await this.q('DELETE FROM sessions WHERE id=$1', [id]); }
  async deleteUserSessions(u: string) { await this.q('DELETE FROM sessions WHERE user_id=$1', [u]); }
  async updateSession(id: string, p: Partial<Session>) { await this.q("UPDATE sessions SET data = data || $2::jsonb WHERE id=$1", [id, JSON.stringify(p)]); }
  async listPasskeys(userId?: string) { return (await this.q<{ data: Passkey }>(userId ? 'SELECT data FROM passkeys WHERE user_id=$1 ORDER BY created_at' : 'SELECT data FROM passkeys ORDER BY created_at', userId ? [userId] : [])).rows.map(r => r.data); }
  async getPasskey(id: string) { return (await this.q<{ data: Passkey }>('SELECT data FROM passkeys WHERE id=$1', [id])).rows[0]?.data ?? null; }
  async createPasskey(p: Passkey) { await this.q('INSERT INTO passkeys (id, user_id, data) VALUES ($1,$2,$3)', [p.id, p.userId, p]); }
  async updatePasskey(id: string, p: Partial<Passkey>) { await this.q("UPDATE passkeys SET data = data || $2::jsonb WHERE id=$1", [id, JSON.stringify(p)]); }
  async deletePasskey(id: string) { await this.q('DELETE FROM passkeys WHERE id=$1', [id]); }
  async createInvite(i: Invite) { await this.q('INSERT INTO invites (id, token_hash, user_id, data) VALUES ($1,$2,$3,$4)', [i.id, i.tokenHash, i.userId, i]); }
  async getInviteByHash(h: string) { return (await this.q<{ data: Invite }>('SELECT data FROM invites WHERE token_hash=$1', [h])).rows[0]?.data ?? null; }
  async listInvites(userId?: string) { return (await this.q<{ data: Invite }>(userId ? 'SELECT data FROM invites WHERE user_id=$1' : 'SELECT data FROM invites', userId ? [userId] : [])).rows.map(r => r.data); }
  async updateInvite(id: string, p: Partial<Invite>) { await this.q("UPDATE invites SET data = data || $2::jsonb WHERE id=$1", [id, JSON.stringify(p)]); }
  async putChallenge(c: PasskeyChallenge) {
    await this.q('DELETE FROM passkey_challenges WHERE expires_at < now()');
    await this.q('INSERT INTO passkey_challenges (id, expires_at, data) VALUES ($1,$2,$3)', [c.id, c.expiresAt, c]);
  }
  async takeChallenge(id: string) { return (await this.q<{ data: PasskeyChallenge }>('DELETE FROM passkey_challenges WHERE id=$1 RETURNING data', [id])).rows[0]?.data ?? null; }
  async countRecentFailures(key: string, since: string) { return Number((await this.q<{ n: string }>('SELECT count(*) n FROM login_attempts WHERE key=$1 AND NOT ok AND at >= $2', [key, since])).rows[0].n); }
  async recordLoginAttempt(key: string, ok: boolean) { await this.q('INSERT INTO login_attempts (key, ok) VALUES ($1,$2)', [key, ok]); if (Math.random() < 0.01) await this.q("DELETE FROM login_attempts WHERE at < now() - interval '1 day'"); }
  async getSettings(scope = 'app') { const v = (await this.q<{ value: Settings }>('SELECT value FROM settings WHERE key=$1', [scope])).rows[0]?.value; return scope === 'app' ? { ...DEFAULT_SETTINGS, ...(v ?? {}) } : (v ?? ({} as Settings)); }
  async putSettings(s: Settings, scope = 'app') { await this.q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [scope, s]); }
  async listWorkspaces() { return (await this.q<{ data: Workspace }>('SELECT data FROM workspaces ORDER BY created_at')).rows.map(r => r.data); }
  async createWorkspace(w: Workspace) { await this.q('INSERT INTO workspaces (id, slug, data, created_at) VALUES ($1,$2,$3,$4)', [w.id, w.slug, w, w.createdAt]); }
  async updateWorkspace(id: string, p: Partial<Workspace>) { await this.q('UPDATE workspaces SET data = data || $2::jsonb WHERE id=$1', [id, JSON.stringify(p)]); }
  async getSecret(n: string) { return (await this.q<{ value: string }>('SELECT value FROM secrets WHERE name=$1', [n])).rows[0]?.value ?? null; }
  async putSecret(n: string, v: string) { await this.q('INSERT INTO secrets (name, value) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [n, v]); }

  async listDatasets() { return (await this.q<{ data: Dataset }>('SELECT data FROM datasets ORDER BY created_at DESC')).rows.map(r => r.data); }
  getDataset(id: string) { return this.one<Dataset>('datasets', id); }
  async createDataset(d: Dataset, bundle?: Uint8Array) {
    const store = bundle ? await this.blobs : null;
    if (store && bundle) {
      // Object storage keeps the original upload for the record; the database keeps a pointer and its hash.
      const key = `datasets/${d.id}/bundle.zip`; await store.put(key, bundle, 'application/zip');
      d = { ...d, bundleKey: key, bundleUrl: store.url(key), bundleSha256: createHash('sha256').update(bundle).digest('hex') };
      await this.q('INSERT INTO datasets (id, data, created_at, bundle) VALUES ($1,$2,$3,NULL)', [d.id, d, d.createdAt]); return;
    }
    await this.q('INSERT INTO datasets (id, data, created_at, bundle) VALUES ($1,$2,$3,$4)', [d.id, d, d.createdAt, bundle ? Buffer.from(bundle) : null]);
  }
  updateDataset(id: string, p: Partial<Dataset>) { return this.merge('datasets', id, p); }
  async deleteDataset(id: string) { await this.q('DELETE FROM datasets WHERE id=$1', [id]); }
  async getBundle(id: string) {
    const row = (await this.q<{ bundle: Buffer | null; data: Dataset }>('SELECT bundle, data FROM datasets WHERE id=$1', [id])).rows[0]; if (!row) return null;
    if (row.data.bundleKey) { const store = await this.blobs; if (!store) throw new Error(`Dataset ${id} is in object storage (${row.data.bundleUrl}) but STORAGE_BACKEND is postgres`); return store.get(row.data.bundleKey); }
    return row.bundle ? new Uint8Array(row.bundle) : null;
  }
  async putCorpus(id: string, c: Corpus) { await this.q('UPDATE datasets SET corpus_gz=$2, bundle=NULL WHERE id=$1', [id, zip(c)]); }
  async getCorpus(id: string) { return unzip<Corpus>((await this.q<{ corpus_gz: Buffer | null }>('SELECT corpus_gz FROM datasets WHERE id=$1', [id])).rows[0]?.corpus_gz ?? null); }

  private split(r: Partial<RunRecord>) { const { result, progress, ...data } = r; return { result, progress, data }; }
  async createRun(r: RunRecord) {
    const { result, progress, data } = this.split(r);
    await this.q('INSERT INTO runs (id, dataset_id, module, status, created_at, requested_by, schedule_id, data, result_gz, progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [r.id, r.datasetId, r.module, r.status, r.createdAt, r.requestedBy, r.scheduleId ?? null, data, result ? zip(result) : null, progress ?? null]);
  }
  async updateRun(id: string, p: Partial<RunRecord>) {
    const { result, progress, data } = this.split(p);
    const sets = ['data = data || $2::jsonb']; const vals: unknown[] = [id, JSON.stringify(data)];
    if (p.status) { vals.push(p.status); sets.push(`status=$${vals.length}`); }
    if (result !== undefined) { vals.push(result ? zip(result) : null); sets.push(`result_gz=$${vals.length}`); }
    if (progress !== undefined) { vals.push(progress ? JSON.stringify(progress) : null); sets.push(`progress=$${vals.length}`); }
    await this.q(`UPDATE runs SET ${sets.join(', ')} WHERE id=$1`, vals);
  }
  private rowToRun(row: { data: RunRecord; status: string; result_gz?: Buffer | null; progress?: RunRecord['progress'] }, withResult: boolean): RunRecord {
    return { ...row.data, status: row.status as RunStatus, result: withResult ? unzip<AuditRun>(row.result_gz ?? null) : null, progress: row.progress ?? null };
  }
  async getRun(id: string, o?: { withResult?: boolean }) {
    const w = o?.withResult !== false;
    const row = (await this.q(`SELECT data, status, progress${w ? ', result_gz' : ''} FROM runs WHERE id=$1`, [id])).rows[0];
    return row ? this.rowToRun(row as never, w) : null;
  }
  async listRuns(f: RunFilter) {
    const where: string[] = []; const v: unknown[] = [];
    if (f.status?.length) { v.push(f.status); where.push(`status = ANY($${v.length})`); }
    if (f.datasetId) { v.push(f.datasetId); where.push(`dataset_id=$${v.length}`); }
    if (f.module) { v.push(f.module); where.push(`module=$${v.length}`); }
    if (f.requestedBy) { v.push(f.requestedBy); where.push(`requested_by=$${v.length}`); }
    if (f.workspaceId) { v.push(f.workspaceId); where.push(`COALESCE(data->>'workspaceId', 'ws_default')=$${v.length}`); }
    v.push(Math.min(f.limit ?? 200, 1000));
    const rows = (await this.q(`SELECT data, status FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${v.length}`, v)).rows;
    return rows.map(r => this.rowToRun(r as never, false));
  }
  async decide(runId: string, fn: (run: RunRecord) => Promise<{ decision: DecisionRecord; status: RunStatus }>) {
    return this.tx(async c => {
      const row = (await c.query('SELECT data, status, result_gz FROM runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
      if (!row) throw new Error('Run not found.');
      const run = this.rowToRun(row, true);
      const { decision, status } = await fn(run);
      const decisions = [...run.decisions, decision];
      await c.query("UPDATE runs SET status=$2, data = data || jsonb_build_object('decisions', $3::jsonb, 'status', $2::text) WHERE id=$1", [runId, status, JSON.stringify(decisions)]);
      return { ...run, decisions, status, result: null };
    });
  }

  listSources() { return this.all<EvidenceSource>('sources').then(s => s.sort((a, b) => a.name.localeCompare(b.name))); }
  getSource(id: string) { return this.one<EvidenceSource>('sources', id); }
  async createSource(x: EvidenceSource) { await this.q('INSERT INTO sources (id, data) VALUES ($1,$2)', [x.id, x]); }
  async updateSource(id: string, p: Partial<EvidenceSource>) { await this.q('UPDATE sources SET data = data || $2::jsonb WHERE id=$1', [id, JSON.stringify(p)]); }
  async deleteSource(id: string) { await this.q('DELETE FROM sources WHERE id=$1', [id]); }

  listSchedules() { return this.all<Schedule>('schedules').then(s => s.sort((a, b) => a.name.localeCompare(b.name))); }
  getSchedule(id: string) { return this.one<Schedule>('schedules', id); }
  async createSchedule(s: Schedule) { await this.q('INSERT INTO schedules (id, enabled, next_run_at, data) VALUES ($1,$2,$3,$4)', [s.id, s.enabled, s.nextRunAt, s]); }
  async updateSchedule(id: string, p: Partial<Schedule>) {
    await this.q(`UPDATE schedules SET data = data || $2::jsonb, enabled = COALESCE(($2::jsonb->>'enabled')::boolean, enabled),
      next_run_at = CASE WHEN $2::jsonb ? 'nextRunAt' THEN ($2::jsonb->>'nextRunAt')::timestamptz ELSE next_run_at END WHERE id=$1`, [id, JSON.stringify(p)]);
  }
  async deleteSchedule(id: string) { await this.q('DELETE FROM schedules WHERE id=$1', [id]); }
  async claimDueSchedules(now: Date, fn: (s: Schedule) => Promise<Partial<Schedule>>) {
    return this.tx(async c => {
      const rows = (await c.query<{ data: Schedule }>('SELECT data FROM schedules WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 25', [now])).rows;
      for (const { data } of rows) {
        const patch = await fn(data);
        await c.query(`UPDATE schedules SET data = data || $2::jsonb, next_run_at = ($2::jsonb->>'nextRunAt')::timestamptz WHERE id=$1`, [data.id, JSON.stringify(patch)]);
      }
      return rows.length;
    });
  }

  async enqueue(j: Job) { await this.q('INSERT INTO jobs (id, kind, payload, status, attempts, max_attempts, run_after, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [j.id, j.kind, j.payload, j.status, j.attempts, j.maxAttempts, j.runAfter, j.createdAt]); }
  private rowToJob(r: Record<string, unknown>): Job { return { id: r.id as string, kind: r.kind as Job['kind'], payload: r.payload as Job['payload'], status: r.status as Job['status'], attempts: r.attempts as number, maxAttempts: r.max_attempts as number,
    runAfter: isoOf(r.run_after)!, lockedBy: r.locked_by as string | null, heartbeatAt: isoOf(r.heartbeat_at), error: r.error as string | null, createdAt: isoOf(r.created_at)! }; }
  async claimJob(workerId: string) {
    const r = (await this.q(`UPDATE jobs SET status='running', locked_by=$1, heartbeat_at=now(), attempts=attempts+1
      WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after <= now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [workerId])).rows[0];
    return r ? this.rowToJob(r) : null;
  }
  async heartbeatJob(id: string) { await this.q('UPDATE jobs SET heartbeat_at=now() WHERE id=$1', [id]); }
  async finishJob(id: string, ok: boolean, error?: string, retryInMs?: number) {
    if (ok) await this.q("UPDATE jobs SET status='done', error=NULL, finished_at=now() WHERE id=$1", [id]);
    else if (retryInMs !== undefined) await this.q(`UPDATE jobs SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, error=$2, locked_by=NULL,
      run_after = now() + ($3 || ' milliseconds')::interval, finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END WHERE id=$1`, [id, error ?? null, String(retryInMs)]);
    else await this.q("UPDATE jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [id, error ?? null]);
  }
  async reapStaleJobs(older: string) {
    const rows = (await this.q(`UPDATE jobs SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END, locked_by=NULL, error='Worker stopped responding'
      WHERE status='running' AND heartbeat_at < $1 RETURNING *`, [older])).rows;
    return rows.map(r => this.rowToJob(r));
  }
  async queueStats() {
    const s: Record<string, number> = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const r of (await this.q<{ status: string; n: string }>("SELECT status, count(*) n FROM jobs WHERE created_at > now() - interval '7 days' OR status IN ('queued','running') GROUP BY status")).rows) s[r.status] = Number(r.n);
    const ready = (await this.q<{ n: string }>("SELECT count(*) n FROM jobs WHERE status='queued' AND run_after <= now()")).rows[0];
    s.ready = Number(ready.n); return s;
  }

  async appendAudit(e: AuditEventInput) {
    return this.tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(717171)');
      const prev = (await c.query<{ seq: string; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
      const base = { ...e, seq: prev ? Number(prev.seq) + 1 : 1, at: new Date().toISOString(), prevHash: prev?.hash ?? 'GENESIS' };
      const ev: AuditEvent = { ...base, hash: await auditHash(base) };
      await c.query('INSERT INTO audit_log (seq, at, actor_id, actor_name, action, target, details, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [ev.seq, ev.at, ev.actorId, ev.actorName, ev.action, ev.target, ev.details, ev.prevHash, ev.hash]);
      return ev;
    });
  }
  private rowToEvent(r: Record<string, unknown>): AuditEvent { return { seq: Number(r.seq), at: isoOf(r.at)!, actorId: r.actor_id as string, actorName: r.actor_name as string, action: r.action as string, target: r.target as string, details: r.details as Record<string, unknown>, prevHash: r.prev_hash as string, hash: r.hash as string }; }
  async listAudit(o: { limit: number; beforeSeq?: number; workspaceId?: string }) {
    const where: string[] = []; const v: unknown[] = [o.limit];
    if (o.beforeSeq) { v.push(o.beforeSeq); where.push(`seq < $${v.length}`); }
    if (o.workspaceId) { v.push(o.workspaceId); where.push(`COALESCE(details->>'workspace', 'ws_default') = $${v.length}`); }
    const rows = (await this.q(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT $1`, v)).rows;
    return rows.map(r => this.rowToEvent(r));
  }
  async allAudit() { return (await this.q('SELECT * FROM audit_log ORDER BY seq')).rows.map(r => this.rowToEvent(r)); }
}
