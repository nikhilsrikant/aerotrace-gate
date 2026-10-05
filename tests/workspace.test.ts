// Workspaces: two programs in one deployment must never see or touch each other's data.
// Runs on the in-memory repo, or on Postgres with TEST_DATABASE_URL (exercising migration 4 and the SQL filters).
import assert from 'node:assert/strict';
import pg from 'pg';
import { MemRepo } from '../lib/core/memRepo';
import { PgRepo } from '../lib/server/pgRepo';
import { Services, HttpError } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { sha256 } from '../lib/engine';
import { DEFAULT_WORKSPACE } from '../lib/core/model';

const fails = async (p: Promise<unknown>, re: RegExp) => { try { await p; } catch (e) { assert.match((e as HttpError).message, re); return; } assert.fail(`expected ${re}`); };

(async () => {
  let repo: MemRepo | PgRepo;
  if (process.env.TEST_DATABASE_URL) { const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL }); await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); repo = new PgRepo(pool); await repo.migrate(); }
  else repo = new MemRepo();
  console.log('repo:', repo.kind);
  const root = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true });
  const s = await seed(repo, root, { demoUsers: true, syntheticDataset: true, hash: p => sha256(p) });
  await repo.updateUser('usr_sam', { platformAdmin: true });
  const A = root.forWorkspace(DEFAULT_WORKSPACE);
  const actor = (svc: Services, id: string) => repo.getUser(id).then(u => svc.actorFor(u!));

  // Only platform admins create workspaces.
  await fails(root.createWorkspace(await actor(A, 'usr_marcus'), { name: 'Rogue' }), /platform administrators/);
  const ws = await root.createWorkspace(await actor(A, 'usr_sam'), { name: 'FCC-2 Flight Controls' });
  const B = root.forWorkspace(ws.id);
  const samB = await actor(B, 'usr_sam');
  assert.ok(samB.permissions.has('access.manage'), 'creator administers the new workspace');

  // Priya belongs to A only.
  const priyaA = await actor(A, 'usr_priya'), priyaB = await actor(B, 'usr_priya');
  assert.equal(priyaB.permissions.size, 0, 'no permissions in a workspace she is not in');
  assert.deepEqual((await root.workspacesFor(priyaA.user)).map(w => w.id), [DEFAULT_WORKSPACE]);
  assert.equal((await root.workspacesFor(samB.user)).length, 2);

  // Data from A is invisible from B.
  const [runA] = await A.startAudits(await actor(A, 'usr_marcus'), { datasetId: s.datasetId!, modules: ['BARO-IN'], layer2: 'heuristic' });
  assert.equal((await B.listDatasets()).length, 0); assert.equal((await B.listRuns(samB)).length, 0);
  await fails(B.getRun(samB, runA), /not found/i);
  await fails(B.decide(samB, runA, 'approve'), /not found/i);
  await fails(B.startAudits(samB, { datasetId: s.datasetId!, modules: ['BARO-IN'] }), /not found/i);
  assert.ok((await B.listPolicies()).every(p => p.workspaceId === ws.id) && (await B.listPolicies()).length === 1);
  assert.ok(!(await B.listGroups()).some(g => g.name === 'Software Quality'));
  assert.equal((await B.listUsers(samB)).some(u => u.id === 'usr_priya'), false, 'B does not list A-only people');
  console.log('isolation: datasets, audits, decisions, policies, groups and people stay in their workspace');

  // B gets its own dataset and audits; its default policy applies (worker routing through root).
  const dsB = await B.createSyntheticDataset(samB, 'FCC-2 synthetic', 179);
  assert.equal((await A.listDatasets()).some(d => d.id === dsB.id), false);
  const [runB] = await B.startAudits(samB, { datasetId: dsB.id, modules: ['YAW-DAMP'], layer2: 'heuristic' });
  const rb = await B.getRun(samB, runB);
  assert.equal(rb.approval.policyName, 'Default: one reviewer');
  assert.equal((await A.listRuns(await actor(A, 'usr_sam'))).some(r => r.id === runB), false);
  // The worker path: root.executeAudit routes a queued run to its own workspace.
  const queued = await B.d.repo.getRun(runB, { withResult: false }); assert.equal(queued?.workspaceId, ws.id);

  // The same person can be added to B with different roles. Then she sees B, as a viewer only.
  await B.createUser(samB, { email: 'priya.raman@example.com', name: 'Priya Raman', roleIds: ['role_viewer'] });
  const priyaB2 = await actor(B, 'usr_priya');
  assert.ok(priyaB2.permissions.has('audit.view') && !priyaB2.permissions.has('audit.request'));
  assert.ok((await actor(A, 'usr_priya')).user.groupIds.length > 0, 'still has her A groups');
  await fails(B.createUser(samB, { email: 'priya.raman@example.com', name: 'Priya', roleIds: [] }), /already in this workspace/);
  assert.equal((await root.workspacesFor(priyaB2.user)).length, 2);
  await fails(B.decide(priyaB2, runB, 'approve'), /not an approver/);

  // API tokens belong to one workspace.
  const tokB = await B.createToken(samB, { name: 'FCC CI' });
  assert.ok(await B.actorFromToken(tokB.token)); assert.equal(await A.actorFromToken(tokB.token), null);

  // Settings: names and notifications per workspace; the passkey policy is organisation-wide and platform-admin only.
  const sb = await B.getSettings(); assert.equal(sb.orgName, 'FCC-2 Flight Controls');
  await B.saveSettings(samB, { ...sb, notifications: { ...sb.notifications, webhookUrl: 'https://hooks.example.com/fcc' } });
  assert.equal((await A.getSettings()).notifications.webhookUrl, '');
  await A.d.repo.updateUser('usr_marcus', { roleIds: ['role_admin'] });   // administers A, but is not a platform admin
  const adminOfA = await actor(A, 'usr_marcus'); assert.ok(adminOfA.permissions.has('settings.manage') && !adminOfA.platformAdmin);
  const sa = await A.getSettings();
  await fails(A.saveSettings(adminOfA, { ...sa, passkeys: { ...sa.passkeys!, stepUpMinutes: 30 } }), /only a platform administrator/);
  await A.saveSettings(await actor(A, 'usr_sam'), { ...sa, passkeys: { ...sa.passkeys!, stepUpMinutes: 30 } });
  assert.equal((await B.getSettings()).passkeys!.stepUpMinutes, 30, 'passkey policy applies to every workspace');

  // Schedules fire inside their own workspace.
  await B.saveSchedule(samB, { name: 'FCC nightly', datasetId: dsB.id, modules: ['TRIM-CTL'], layer2: 'heuristic', recurrence: { kind: 'interval', everyMinutes: 60 }, timezone: 'UTC', enabled: true, skipIfPending: true, notifyOn: [] });
  assert.equal((await A.listSchedules()).some(x => x.name === 'FCC nightly'), false);
  const sch = (await B.listSchedules())[0];
  const fired = await B.runScheduleNow(samB, sch.id);
  assert.equal((await B.getRun(samB, fired[0])).module, 'TRIM-CTL');

  // Evidence sources belong to one workspace (on Postgres this exercises migration 5).
  const t = new Date().toISOString();
  await B.d.repo.createSource({ id: 'src_b', name: 'FCC Git', git: { provider: 'github', repo: 'acme/fcc', ref: 'main' }, createdBy: 'usr_sam', createdAt: t, updatedAt: t });
  assert.equal((await A.listSources()).length, 0); assert.equal((await B.listSources())[0].workspaceId, ws.id);
  await B.d.repo.updateSource('src_b', { lastSync: { at: t, status: 'ok', datasetId: dsB.id } });
  assert.equal((await B.d.repo.getSource('src_b'))!.lastSync!.datasetId, dsB.id); assert.equal(await A.d.repo.getSource('src_b'), null);
  await assert.rejects(A.d.repo.deleteSource('src_b'), /not found/);

  // Audit log: each workspace reads its own entries; the chain is still one and intact.
  const logB = await B.auditLog(samB, 500);
  assert.ok(logB.length > 0 && logB.every(e => e.details.workspace === ws.id));
  assert.ok(!(await A.auditLog(await actor(A, 'usr_sam'), 500)).some(e => e.details.workspace === ws.id));
  assert.ok((await root.verifyAuditLog(await actor(A, 'usr_sam'))).ok);
  console.log('workspace: all checks passed');
  if (repo instanceof PgRepo) await repo.pool.end();
})().catch(e => { console.error(e); process.exit(1); });
