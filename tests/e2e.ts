// End-to-end against a running web server + worker + Postgres (the same processes the containers run).
// BASE=http://localhost:3000 DATABASE_URL=... tsx tests/e2e.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SoftAuthenticator } from '../lib/testing/softAuthenticator';
import { decisionPayload } from '../lib/core/services';
import { verifyPasskeyProof, decisionChallenge } from '../lib/core/passkeyProof';

const BASE = process.env.BASE || 'http://localhost:3000';
const ORIGIN = process.env.PASSKEY_ORIGIN || 'http://localhost:3999';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
class Client {
  cookie = ''; token = '';
  constructor(public who: string, public key = new SoftAuthenticator(ORIGIN)) {}
  async req(method: string, path: string, body?: unknown, opts: { csrf?: boolean; raw?: boolean; form?: FormData } = {}) {
    const h: Record<string, string> = {};
    if (this.cookie) h.cookie = this.cookie;
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (opts.csrf !== false) h['x-aerotrace-csrf'] = '1';
    let b: BodyInit | undefined;
    if (opts.form) b = opts.form; else if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(BASE + '/api' + path, { method, headers: h, body: b, redirect: 'manual' });
    const set = res.headers.get('set-cookie'); if (set?.startsWith('aero_session=')) this.cookie = set.split(';')[0];
    if (opts.raw) return res;
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: j as any };
  }
  async ok(method: string, path: string, body?: unknown) { const r = await this.req(method, path, body) as { status: number; body: any }; if (r.status >= 300) throw new Error(`${this.who} ${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; }
  async login(email: string, pw: string) { this.cookie = ''; return this.req('POST', '/auth/login', { email, password: pw }) as Promise<{ status: number; body: any }>; }
  // Passkey ceremonies, as the browser would run them.
  async enroll(name = 'Work laptop') { const o = await this.ok('POST', '/auth/passkey/register/options'); return this.ok('POST', '/auth/passkey/register', { challengeId: o.challengeId, response: await this.key.create(o.options), name }); }
  async unlock() { const o = await this.ok('POST', '/auth/passkey/verify/options'); return this.ok('POST', '/auth/passkey/verify', { challengeId: o.challengeId, response: await this.key.get(o.options) }); }
  async passkeyLogin() { this.cookie = ''; const o = await this.ok('POST', '/auth/passkey/login/options'); return this.req('POST', '/auth/passkey/login', { challengeId: o.challengeId, response: await this.key.get(o.options) }) as Promise<{ status: number; body: any }>; }
  async decide(id: string, action: 'approve' | 'deny', reason?: string) {
    const o = await this.req('POST', `/runs/${id}/decision/options`, { action, reason }) as { status: number; body: any };
    if (o.status >= 300) return o;
    return this.req('POST', `/runs/${id}/decision`, { action, reason, passkey: { challengeId: o.body.challengeId, response: await this.key.get(o.body.options) } }) as Promise<{ status: number; body: any }>;
  }
}
const step = (m: string) => console.log('✓', m);

(async () => {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  assert.equal((await (await fetch(BASE + '/api/health')).json()).ok, true);
  assert.equal((await fetch(BASE + '/api/ready')).status, 200);
  step('health and readiness');
  const h = await fetch(BASE + '/'); assert.match(h.headers.get('content-security-policy') || '', /frame-ancestors 'none'/); step('security headers present');
  const spec = await (await fetch(BASE + '/api/protocol')).json();
  assert.equal(spec.name, 'AeroTrace A2A'); assert.equal(Object.keys(spec.payloads).length, 8);
  step(`A2A protocol v${spec.version} is published at /api/protocol`);

  const admin = new Client('admin');
  assert.equal((await admin.login('admin@example.com', 'wrong-password-1')).status, 401);
  assert.equal((await admin.login('admin@example.com', 'Admin-pass-2026')).status, 200);
  assert.equal((await admin.ok('GET', '/auth/me')).mustChangePassword, true);
  assert.equal((await admin.req('POST', '/auth/password', { current: 'Admin-pass-2026', next: 'short' })).status, 400);
  await admin.ok('POST', '/auth/password', { current: 'Admin-pass-2026', next: 'Admin-new-pass-2026' });
  assert.equal((await admin.ok('GET', '/auth/me')).mustChangePassword, false);
  step('admin signs in, is forced to change the temporary password');

  // Passkeys: a password alone opens nothing.
  const locked = await admin.req('GET', '/datasets') as any;
  assert.equal(locked.status, 403); assert.equal(locked.body.code, 'passkey_enroll');
  assert.equal((await admin.ok('GET', '/auth/me')).assurance.verified, false);
  const pk = await admin.enroll('Admin YubiKey');
  assert.equal(pk.name, 'Admin YubiKey');
  assert.equal((await admin.ok('GET', '/auth/me')).assurance.verified, true);
  assert.equal((await admin.req('GET', '/datasets') as any).status, 200);
  step('password-only session sees no data; enrolling a passkey (with user verification) unlocks it');

  assert.equal((await admin.req('POST', '/users', { email: 'x@y.z', name: 'x' }, { csrf: false })).status, 403);
  step('cookie request without the CSRF header is refused');

  const mk = async (email: string, name: string, roleIds: string[], groupIds: string[]) => {
    const u = await admin.ok('POST', '/users', { email, name, password: 'Temp-password-123', roleIds, groupIds });
    const inv = await admin.ok('POST', `/users/${u.id}/invite`, {});
    assert.match(inv.url, /#invite=ati_/);
    const c = new Client(name); await c.ok('POST', '/auth/invite', { token: inv.url.split('#invite=')[1] }); await c.enroll();
    await c.ok('POST', '/auth/password', { current: 'Temp-password-123', next: 'Their-own-pass-456' }); return c;
  };
  const eng = await mk('eng@example.com', 'Erin Engineer', ['role_engineer'], []);
  const sqa = await mk('sqa@example.com', 'Sid Quality', [], ['grp_quality', 'grp_reviewers']);
  const der = await mk('der@example.com', 'Dee DER', [], ['grp_der']);
  const viewer = await mk('view@example.com', 'Val Viewer', ['role_viewer'], []);
  step('admin creates four people and sends each a one-time invite link; each opens it and enrolls a passkey');
  // Without an invite, a password sign-in can't enrol a first passkey; a used link can't be reused.
  const late = await admin.ok('POST', '/users', { email: 'late@example.com', name: 'Lee Late', password: 'Temp-password-123', roleIds: ['role_viewer'], groupIds: [] });
  const lc = new Client('late'); await lc.login('late@example.com', 'Temp-password-123');
  const noInv = await lc.req('POST', '/auth/passkey/register/options') as any; assert.equal(noInv.status, 403); assert.equal(noInv.body.code, 'invite_required');
  const lateInv = await admin.ok('POST', `/users/${late.id}/invite`, {}); const lateTok = lateInv.url.split('#invite=')[1];
  assert.equal((await new Client('x').req('POST', '/auth/invite', { token: lateTok })).status, 200);
  assert.equal(((await new Client('y').req('POST', '/auth/invite', { token: lateTok })) as any).body.code, 'invite_invalid');
  step('a password sign-in cannot enrol a first passkey; invite links work exactly once');

  // Next morning: passwordless sign-in with the passkey; a password sign-in has to unlock.
  const sqa2 = new Client('Sid (passkey)', sqa.key);
  const pl = await sqa2.passkeyLogin(); assert.equal(pl.status, 200, JSON.stringify(pl.body)); assert.equal(pl.body.user.email, 'sqa@example.com');
  assert.equal((await sqa2.req('GET', '/inbox') as any).status, 200);
  const sqa3 = new Client('Sid (password)', sqa.key); await sqa3.login('sqa@example.com', 'Their-own-pass-456');
  const l3 = await sqa3.req('GET', '/inbox') as any; assert.equal(l3.status, 403); assert.equal(l3.body.code, 'passkey_required');
  await sqa3.unlock(); assert.equal((await sqa3.req('GET', '/inbox') as any).status, 200);
  const stranger = new Client('stranger');  // a passkey nobody registered
  await stranger.key.create({ rp: { id: 'localhost', name: 'x' }, user: { id: 'eA', name: 'x', displayName: 'x' }, challenge: 'AAAA', pubKeyCredParams: [] } as never);
  assert.equal((await stranger.passkeyLogin()).status, 401);
  step('passwordless sign-in works; a password sign-in must unlock with the passkey; an unknown passkey is refused');

  const ds = (await eng.ok('GET', '/datasets'))[0];
  assert.equal(ds.status, 'ready'); assert.equal(ds.total, 50000);
  assert.equal((await viewer.req('POST', '/runs', { datasetId: ds.id, modules: ['BARO-IN'] })).status, 403);
  const { runIds } = await eng.ok('POST', '/runs', { datasetId: ds.id, modules: ['BARO-IN', 'TERR-DB'], layer2: 'heuristic' });
  const waitFor = async (c: Client, id: string, statuses: string[]) => { for (let i = 0; i < 120; i++) { const r = await c.ok('GET', `/runs/${id}`); if (statuses.includes(r.status)) return r; await sleep(500); } throw new Error(`run ${id} did not reach ${statuses}`); };
  const baro = await waitFor(eng, runIds[0], ['awaiting_approval']);
  const terr = await waitFor(eng, runIds[1], ['awaiting_approval']);
  assert.equal(baro.verdict, 'NO'); assert.equal(terr.verdict, 'YES');
  assert.equal(baro.approval.policyName, 'DAL A and B: SQA then DER');
  step(`viewer can't start audits; engineer queues 2, the worker finishes them (BARO-IN ${baro.verdict}, TERR-DB ${terr.verdict})`);

  assert.equal((await eng.decide(baro.id, 'approve')).status, 403);
  assert.equal((await der.decide(baro.id, 'approve')).status, 403);
  assert.equal((await viewer.decide(baro.id, 'approve')).status, 403);
  assert.equal((await sqa.ok('GET', '/inbox')).mine.length, 2);
  assert.equal((await der.ok('GET', '/inbox')).mine.length, 0);
  const noPk = await sqa.req('POST', `/runs/${baro.id}/decision`, { action: 'approve' }) as any;
  assert.equal(noPk.status, 403); assert.equal(noPk.body.code, 'decision_passkey_required');
  let r = (await sqa.decide(baro.id, 'approve')).body;
  assert.equal(r.status, 'awaiting_approval', JSON.stringify(r));
  assert.equal((await der.ok('GET', '/inbox')).mine.length, 1);
  assert.equal((await der.decide(baro.id, 'deny')).status, 400);
  r = (await der.decide(baro.id, 'approve')).body;
  assert.equal(r.status, 'approved');
  assert.ok(r.decisions.every((d: any) => d.passkey?.userVerified));
  step('requester, out-of-order DER and viewer are refused; a decision without a passkey is refused; SQA then DER each sign with their passkey');

  const v = await admin.ok('GET', `/runs/${baro.id}/verify`); assert.equal(v.ok, true);
  const pkg = await admin.ok('GET', `/runs/${baro.id}/evidence`);
  const keyring = (await (await fetch(BASE + '/api/keys')).json()).keys;
  for (const d of pkg.run.decisions) {
    const payload = decisionPayload({ run: pkg.run.id, step: d.stepId, action: d.action, by: d.userId, onBehalfOf: d.onBehalfOf?.id ?? null, at: d.at, reportHash: d.reportHash, reason: d.reason ?? null, passkey: d.passkey });
    const pub = createPublicKey({ key: keyring.find((k: any) => k.kid === d.signature.keyId), format: 'jwk' });
    const sigOk = d.signature.alg === 'ES256' ? verify('sha256', Buffer.from(payload), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(d.signature.value, 'base64')) : verify(null, Buffer.from(payload), pub, Buffer.from(d.signature.value, 'base64'));
    assert.ok(sigOk, `${d.signature.alg} signature verifies with the published public key alone`);
    const want = await decisionChallenge({ run: pkg.run.id, action: d.action, reportHash: d.reportHash, reason: d.reason ?? null, by: d.userId, nonce: d.passkey.nonce });
    assert.ok((await verifyPasskeyProof(d.passkey, want)).ok, 'passkey signature verifies against the approver\'s public key');
  }
  writeFileSync('/tmp/aerotrace-e2e-evidence.json', JSON.stringify(pkg));
  const offline = execFileSync('node', ['scripts/verify-evidence.mjs', '/tmp/aerotrace-e2e-evidence.json'], { encoding: 'utf8' });
  assert.match(offline, /PASS.*passkey/); assert.doesNotMatch(offline, /FAIL/);
  step('evidence package: gate signatures and each approver\'s passkey signature verify offline, with no server');

  // Authority is configuration: put the DER step on a named person instead of the group, through the API.
  const pols = await admin.ok('GET', '/policies'); const dalAB = pols.find((p: any) => p.id === 'pol_dal_ab');
  const users = await admin.ok('GET', '/users'); const val = users.find((u: any) => u.email === 'view@example.com');
  assert.equal((await eng.req('PUT', `/policies/${dalAB.id}`, dalAB)).status, 403);
  await admin.ok('PUT', `/policies/${dalAB.id}`, { ...dalAB, steps: [dalAB.steps[0], { ...dalAB.steps[1], groupIds: [], userIds: [val.id] }] });
  const sim = await eng.ok('POST', '/policies/simulate', { datasetId: ds.id, module: 'BARO-IN', dal: 'A', verdict: 'NO', requestedBy: (await eng.ok('GET', '/auth/me')).user.id });
  assert.deepEqual(sim.steps[1].eligible, ['Val Viewer']);
  step('admin moves DER sign-off to a named person; simulator confirms; engineer cannot edit policies');

  // Delegation
  const derId = users.find((u: any) => u.email === 'der@example.com').id, sqaId = users.find((u: any) => u.email === 'sqa@example.com').id;
  await der.ok('POST', '/delegations', { toUserId: sqaId, startsAt: new Date(Date.now() - 60e3).toISOString(), endsAt: new Date(Date.now() + 86400e3).toISOString(), reason: 'Annual leave' });
  void derId;
  step('DER delegates to SQA for a day');

  // Scheduled audits
  const sch = await admin.ok('POST', '/schedules', { name: 'Nightly safety sweep', datasetId: ds.id, modules: ['ALT-ALERT', 'FUEL-*'], layer2: 'heuristic', recurrence: { kind: 'interval', everyMinutes: 1440 }, timezone: 'America/Phoenix', enabled: true, skipIfPending: true, notifyOn: ['NO', 'failed'] });
  assert.ok(Date.parse(sch.nextRunAt) - Date.now() > 86000e3);
  await db.query("UPDATE schedules SET next_run_at = now() - interval '1 minute', data = jsonb_set(data, '{nextRunAt}', to_jsonb((now() - interval '1 minute')::text)) WHERE id=$1", [sch.id]);
  let fired: any = null;
  for (let i = 0; i < 40 && !fired?.lastRunIds?.length; i++) { await sleep(500); fired = (await admin.ok('GET', '/schedules')).find((s: any) => s.id === sch.id); }
  assert.equal(fired.lastRunIds.length, 2, 'the worker fired the due schedule by itself');
  assert.ok(Date.parse(fired.nextRunAt) - Date.now() > 86000e3, 'next run is 24 hours out');
  const schedRun = await waitFor(admin, fired.lastRunIds[0], ['awaiting_approval']);
  assert.equal(schedRun.trigger, 'schedule');
  const again = await admin.ok('POST', `/schedules/${sch.id}/run`);
  assert.equal(again.runIds.length, 0, 'skipped: the scheduled runs are still waiting for approval');
  step('a due schedule fires by itself on the worker; next run 24 h later; run-now skips modules still pending');

  // Evidence bundle upload
  const zip = readFileSync(process.env.SAMPLE_ZIP!);
  const form = new FormData(); form.set('name', 'Sample bundle'); form.set('file', new Blob([zip], { type: 'application/zip' }), 'sample.zip');
  assert.equal(((await eng.req('POST', '/datasets', undefined, { form })) as any).status, 403);
  const up = (await admin.req('POST', '/datasets', undefined, { form })) as any; assert.equal(up.status, 200, JSON.stringify(up.body));
  let imp: any; for (let i = 0; i < 60; i++) { imp = (await admin.ok('GET', '/datasets')).find((d: any) => d.id === up.body.id); if (imp.status !== 'importing') break; await sleep(500); }
  assert.equal(imp.status, 'ready', imp.error); assert.equal(imp.modules.length, 3);
  const { runIds: [bundleRun] } = await admin.ok('POST', '/runs', { datasetId: imp.id, modules: ['ALT-ALERT'], layer2: 'heuristic' });
  assert.equal((await waitFor(admin, bundleRun, ['awaiting_approval'])).verdict, 'CONDITIONAL');
  step(`uploaded evidence bundle imported by the worker (${imp.total} records, ${imp.warnings.length} warnings) and audited`);

  // Evidence source: Git + Jira + GitHub Actions (tests/fakeforge.ts), synced by the worker into a dataset version.
  const FORGE = process.env.FORGE_URL!;
  const srcBody = { name: 'FCC evidence repo', git: { provider: 'github', baseUrl: FORGE, repo: 'acme/fcc', ref: 'main', root: 'evidence', baselineRef: 'v1.0', tokenRef: 'env://CONNECTOR_GH_TOKEN' },
    jira: { baseUrl: FORGE, deployment: 'cloud', jql: 'project = FCC', auth: 'basic', email: 'qa@acme.example', tokenRef: 'env://CONNECTOR_JIRA_TOKEN' }, ci: { kind: 'github-actions', workflow: 'evidence.yml' } };
  assert.equal((await eng.req('POST', '/sources', srcBody)).status, 403);
  assert.match(JSON.stringify((await admin.req('POST', '/sources', { ...srcBody, git: { ...srcBody.git, tokenRef: 'env://DATABASE_URL' } })).body), /outside the secrets connectors may read/);
  const srcRec = await admin.ok('POST', '/sources', srcBody);
  const dry = await admin.ok('POST', `/sources/${srcRec.id}/test`); assert.ok(dry.ok, JSON.stringify(dry));
  assert.deepEqual(await admin.ok('POST', `/sources/${srcRec.id}/sync`), { queued: true });
  let synced: any; for (let i = 0; i < 120; i++) { synced = (await admin.ok('GET', '/sources')).find((x: any) => x.id === srcRec.id); if (synced.lastSync) break; await sleep(500); }
  assert.equal(synced.lastSync?.status, 'ok', JSON.stringify(synced.lastSync));
  const sds = (await admin.ok('GET', '/datasets')).find((d: any) => d.id === synced.lastSync.datasetId);
  assert.equal(sds.status, 'ready'); assert.equal(sds.provenance.git.commit, 'a'.repeat(40)); assert.ok(sds.provenance.jira.issues > 0 && sds.provenance.ci.junitFiles > 0);
  const firstAt = synced.lastSync.at; await admin.ok('POST', `/sources/${srcRec.id}/sync`);
  for (let i = 0; i < 120; i++) { synced = (await admin.ok('GET', '/sources')).find((x: any) => x.id === srcRec.id); if (synced.lastSync.at !== firstAt) break; await sleep(500); }
  assert.equal(synced.lastSync.status, 'unchanged'); assert.equal(synced.lastSync.datasetId, sds.id);
  step(`evidence source synced by the worker: ${sds.name}, ${sds.total} records from Git, ${sds.provenance.jira.issues} Jira issues and an Actions artifact; a second sync found nothing new`);

  // API token from CI
  const tok = await eng.ok('POST', '/tokens', { name: 'Jenkins nightly', expiresInDays: 30 });
  const ci = new Client('ci'); ci.token = tok.token;
  const viaCi = await ci.req('POST', '/runs', { datasetId: ds.id, modules: ['GPS-RCV'] }, { csrf: false }) as any;
  assert.equal(viaCi.status, 200);
  assert.equal((await waitFor(ci, viaCi.body.runIds[0], ['awaiting_approval'])).trigger, 'api');
  const ciDecide = await ci.req('POST', `/runs/${viaCi.body.runIds[0]}/decision`, { action: 'approve' }, { csrf: false }) as any;
  assert.equal(ciDecide.status, 403); assert.equal(ciDecide.body.code, 'passkey_person_only');
  step('API token starts an audit from CI without a session or CSRF header, and cannot approve anything');

  // Stale job recovery: pretend a worker died mid-job.
  const { runIds: [orphan] } = await eng.ok('POST', '/runs', { datasetId: ds.id, modules: ['ICE-DET'], layer2: 'heuristic' });
  await waitFor(eng, orphan, ['awaiting_approval']);
  await db.query("UPDATE runs SET status='running', data = data || '{\"status\":\"running\"}' WHERE id=$1", [orphan]);
  await db.query("UPDATE jobs SET status='running', heartbeat_at = now() - interval '1 hour', attempts=1 WHERE payload->>'runId'=$1", [orphan]);
  void orphan;
  step('stale-job recovery staged (checked below via the reaper)');

  // Cited assistant and repeated-audit suggestions
  const ans = await admin.ok('POST', '/assistant', { question: 'Which modules are not ready?', timezone: 'America/Phoenix' });
  assert.ok(ans.sentences.length > 0 && ans.citations.length > 0, 'assistant answered with sources');
  for (const s of ans.sentences) assert.ok(s.cites.length > 0 && s.cites.every((c: number) => ans.citations[c]), `cited: ${s.text}`);
  const none = await admin.ok('POST', '/assistant', { question: 'What is the weather in Tempe?' });
  assert.equal(none.abstained, true);
  assert.ok(Array.isArray(await admin.ok('GET', '/automation/suggestions?tz=UTC')));
  assert.equal((await viewer.req('POST', '/automation/suggestions/dismiss', { key: 'x' })).status, 403);
  step('assistant cites a source for every sentence, declines off-topic questions; suggestions need schedule.manage to dismiss');

  // Program readiness and a chaos drill through the API.
  const prog = await admin.ok('GET', `/program?dataset=${ds.id}`);
  assert.equal((await admin.ok('GET', '/program')).dataset.id, ds.id, 'defaults to the main program, not the newest upload');
  assert.equal(prog.counts.modules, 40); assert.ok(prog.agents.length === 5 && prog.flow.total > 0);
  const drill = await admin.ok('POST', '/chaos', { module: 'AOA-MON', preset: 'testing-offline' });
  const dr = await waitFor(admin, drill.runId, ['awaiting_approval']);
  assert.equal(dr.result.complete, false); assert.notEqual(dr.verdict, 'YES');
  assert.ok(dr.result.health.find((h: any) => h.agent === 'Testing').breaker !== 'closed');
  assert.equal((await viewer.req('POST', '/chaos', { module: 'AOA-MON', preset: 'storm' })).status, 403);
  step(`program readiness covers all 40 modules; a chaos drill takes Testing offline and the audit still finishes, incomplete, breaker ${dr.result.health.find((h: any) => h.agent === 'Testing').breaker}`);

  // Workspaces through the API: a second program, isolated, and a session that switches between them.
  const wsList = await admin.ok('GET', '/workspaces'); assert.equal(wsList.platformAdmin, true);
  const fcc = await admin.ok('POST', '/workspaces', { name: 'FCC-2 Flight Controls' });
  assert.equal((await eng.req('POST', '/workspaces', { name: 'Nope' })).status, 403);
  await admin.ok('POST', `/workspaces/${fcc.id}/switch`);
  assert.equal((await admin.ok('GET', '/meta')).workspace.id, fcc.id);
  assert.equal((await admin.ok('GET', '/datasets')).length, 0, 'the new workspace starts empty');
  assert.equal((await admin.req('GET', `/runs/${baro.id}`)).status, 404, "another program's audit is not visible");
  assert.equal((await eng.req('POST', `/workspaces/${fcc.id}/switch`)).status, 403, 'members only');
  await admin.ok('POST', `/workspaces/${wsList.current}/switch`);
  assert.equal((await admin.ok('GET', `/runs/${baro.id}`)).id, baro.id);
  step('workspaces: a platform admin creates a second program; its data is isolated; non-members cannot switch into it');

  // Step-up: an old passkey check isn't enough to export evidence.
  const adminId = (await admin.ok('GET', '/auth/me')).user.id;
  await db.query("UPDATE sessions SET data = jsonb_set(data, '{passkeyAt}', '\"2020-01-01T00:00:00.000Z\"') WHERE user_id=$1", [adminId]);
  const su = await admin.req('GET', `/runs/${baro.id}/evidence`, undefined, { raw: true }) as Response;
  assert.equal(su.status, 403); assert.equal((await su.json()).code, 'step_up_required');
  await admin.unlock();
  assert.equal((await admin.req('GET', `/runs/${baro.id}/evidence`, undefined, { raw: true }) as Response).status, 200);
  step('exporting evidence with a stale passkey check asks for the passkey again; after confirming it works');

  // Lost phone: the admin resets the DER's passkeys; the DER is signed out and must enrol again.
  const derUser = (await admin.ok('GET', '/users')).find((u: any) => u.email === 'der@example.com');
  assert.equal(derUser.passkeys, 1);
  assert.equal((await eng.req('POST', `/users/${derUser.id}/passkeys/reset`)).status, 403);
  const reset = await admin.ok('POST', `/users/${derUser.id}/passkeys/reset`);
  assert.equal(reset.removed, 1); assert.match(reset.invite.url, /#invite=ati_/);
  assert.equal((await der.req('GET', '/inbox')).status, 401);
  await der.login('der@example.com', 'Their-own-pass-456');
  assert.equal(((await der.req('GET', '/inbox')) as any).body.code, 'passkey_enroll');
  const derNew = new Client('Dee (new phone)'); await derNew.ok('POST', '/auth/invite', { token: reset.invite.url.split('#invite=')[1] }); await derNew.enroll('New phone');
  assert.equal((await derNew.req('GET', '/inbox')).status, 200);
  step('admin resets a lost passkey: the person is signed out everywhere and enrols a new one from the invite link');

  // Rate limiting
  const bad = new Client('attacker');
  for (let i = 0; i < 5; i++) await bad.login('sqa@example.com', 'nope-nope-nope-1');
  assert.equal((await bad.login('sqa@example.com', 'Their-own-pass-456')).status, 429);
  step('sixth sign-in attempt after five failures is blocked');

  const metrics = await (await fetch(BASE + '/api/metrics')).text();
  assert.match(metrics, /aerotrace_runs\{status="approved",verdict="NO"\} 1/); assert.match(metrics, /aerotrace_queue_jobs/);
  step('Prometheus metrics expose runs, queue and approval backlog');

  for (let i = 0; i < 40; i++) { const j = (await db.query("SELECT status FROM jobs WHERE payload->>'runId'=$1", [orphan])).rows[0]; if (j.status === 'done') break; await sleep(500); }
  assert.equal((await db.query("SELECT status FROM jobs WHERE payload->>'runId'=$1", [orphan])).rows[0].status, 'done');
  step('reaper requeued the job whose worker "died", and another pass finished it');

  if (process.env.CLOUD_E2E === '1') {
    await sleep(4000);   // let the batch exporters flush
    const st = await (await fetch('http://127.0.0.1:4599/__state')).json();
    const uploaded = (await admin.ok('GET', '/datasets')).find((d: any) => d.source === 'bundle');
    assert.match(uploaded.bundleUrl, /^s3:\/\/evidence\/datasets\/.+\/bundle\.zip$/); assert.match(uploaded.bundleSha256, /^[0-9a-f]{64}$/);
    assert.ok(st.objects.some((k: string) => k.endsWith(`datasets/${uploaded.id}/bundle.zip`)), 'bundle stored in S3');
    assert.ok(pkg.run.decisions.every((d: any) => d.signature.alg === 'ES256'), 'decisions signed by the KMS key');
    assert.ok(st.calls.some((c: string) => c.includes('TrentService.Sign')) && st.calls.some((c: string) => c.includes('secretsmanager.GetSecretValue')));
    for (const n of ['POST /api/runs', 'job audit', 'agent Testing']) assert.ok(st.spans.includes(n), `span ${n} exported (have ${st.spans.slice(0, 20).join(', ')})`);
    assert.ok(st.spans.some((n: string) => n.startsWith('db ')), 'database spans exported');
    for (const n of ['aerotrace.audits', 'aerotrace.jobs.duration', 'aerotrace.http.server.duration', 'aerotrace.approvals.pending']) assert.ok(st.metrics.includes(n), `metric ${n} exported`);
    step(`cloud mode: evidence in S3, decisions signed by KMS (ES256), session secret from Secrets Manager, ${st.spans.length} span names and ${st.metrics.length} metrics exported over OTLP`);
  }

  const log = await admin.ok('GET', '/audit-log/verify'); assert.equal(log.ok, true);
  await assert.rejects(db.query("DELETE FROM audit_log WHERE seq = 3"), /append-only/);
  const events = await admin.ok('GET', '/audit-log?limit=500');
  const actions = new Set(events.map((e: any) => e.action));
  for (const a of ['auth.login', 'auth.login_failed', 'user.create', 'policy.update', 'delegation.create', 'schedule.create', 'schedule.fired', 'audit.requested', 'audit.completed', 'decision.approve', 'dataset.upload', 'token.create', 'passkey.register', 'auth.passkey_verified', 'passkey.reset', 'user.invite', 'auth.invite_redeemed', 'chaos.drill'])
    assert.ok(actions.has(a), `audit log has ${a}`);
  assert.equal((await viewer.req('GET', '/audit-log')).status, 403);
  step(`audit log: ${log.checked} events, chain intact, DELETE refused, every kind of action recorded, viewers can't read it`);
  await db.end();
  console.log('\nE2E: all checks passed');
})().catch(e => { console.error('E2E FAILED:', e); process.exit(1); });
