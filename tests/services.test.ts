// Approval authority, delegation, schedules and the audit log, end to end on the in-memory repo.
import assert from 'node:assert/strict';
import { MemRepo } from '../lib/core/memRepo';
import { Services, HttpError } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed, ids } from '../lib/core/seed';
import { sha256 } from '../lib/engine';
import { PgRepo } from '../lib/server/pgRepo';
import pg from 'pg';

const fail = async (p: Promise<unknown>, re: RegExp) => { try { await p; } catch (e) { assert.match((e as Error).message, re); return e as HttpError; } assert.fail(`expected failure ${re}`); };

(async () => {
  let clock = new Date('2026-10-03T15:00:00Z');
  const usePg = !!process.env.TEST_DATABASE_URL;
  let repo: MemRepo | PgRepo;
  if (usePg) {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    repo = new PgRepo(pool); await repo.migrate();
  } else repo = new MemRepo();
  console.log('repo:', repo.kind);
  const svc = new Services({ repo, signer: await hmacSigner('test'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true, now: () => clock });
  const s = await seed(repo, svc, { demoUsers: true, syntheticDataset: true, hash: p => sha256(p) });
  const ds = s.datasetId!;
  const actor = async (id: string) => svc.actorFor((await repo.getUser(id))!);
  const [sam, marcus, priya, dana, jordan] = await Promise.all(['usr_sam', 'usr_marcus', 'usr_priya', 'usr_dana', 'usr_lee'].map(actor));

  // Viewers can't start audits; engineers can.
  await fail(svc.startAudits(jordan, { datasetId: ds, modules: ['BARO-IN'] }), /permission/);
  const [baro] = await svc.startAudits(marcus, { datasetId: ds, modules: ['BARO-IN'], layer2: 'heuristic' });
  let r = await svc.getRun(marcus, baro);
  assert.equal(r.status, 'awaiting_approval'); assert.equal(r.verdict, 'NO');
  assert.equal(r.approval.policyName, 'DAL A and B: SQA then DER');
  console.log('BARO-IN', r.verdict, '|', r.approval.waitingOn);

  // Requester can't sign; the DER can't jump the sequential queue; a viewer can't act at all.
  await fail(svc.decide(marcus, baro, 'approve'), /not an approver/);
  await fail(svc.decide(dana, baro, 'approve'), /not an approver/);
  await fail(svc.decide(jordan, baro, 'approve'), /not an approver/);
  assert.equal((await svc.inbox(priya)).mine.length, 1); assert.equal((await svc.inbox(dana)).mine.length, 0);

  // SQA approves, then DER is on vacation and delegates to Sam; Sam signs on her behalf.
  r = await svc.decide(priya, baro, 'approve');
  assert.equal(r.status, 'awaiting_approval'); assert.match(r.approval.waitingOn, /Certification/);
  await fail(svc.decide(priya, baro, 'approve'), /not an approver/);  // same person can't fill two steps
  await svc.createDelegation(dana, { toUserId: 'usr_sam', startsAt: clock.toISOString(), endsAt: new Date(clock.getTime() + 7 * 86400e3).toISOString(), reason: 'Annual leave' });
  await fail(svc.decide(sam, baro, 'deny'), /asks for a reason/);
  r = await svc.decide(sam, baro, 'approve');
  assert.equal(r.status, 'approved');
  assert.equal(r.decisions[1].onBehalfOf?.name, 'Dana Ortiz');
  console.log('approved by', r.decisions.map(d => `${d.userName}${d.onBehalfOf ? ` for ${d.onBehalfOf.name}` : ''} (${d.stepName})`).join(', '));
  assert.ok((await svc.verifyRun(sam, baro)).ok);

  // Authority is data: move DER sign-off to a named person, and a new DAL A run follows the new rule.
  const pol = (await svc.listPolicies()).find(p => p.id === 'pol_dal_ab')!;
  await svc.savePolicy(sam, { ...pol, steps: [pol.steps[0], { ...pol.steps[1], groupIds: [], userIds: ['usr_lee'] }] });
  await fail(svc.savePolicy(marcus, pol), /permission/);
  const sim = await svc.simulatePolicy({ datasetId: ds, module: 'BARO-IN', dal: 'A', verdict: 'NO', requestedBy: 'usr_marcus' });
  console.log('simulator:', sim.policy?.name, 'v' + sim.policy?.version, sim.steps.map(x => `${x.name}: ${x.eligible.join(', ') || '(after previous step)'}`).join(' | '));
  const [baro2] = await svc.startAudits(marcus, { datasetId: ds, modules: ['BARO-IN'], layer2: 'heuristic' });
  await svc.decide(priya, baro2, 'approve');
  await fail(svc.decide(dana, baro2, 'approve'), /not an approver/);
  r = await svc.decide(jordan, baro2, 'deny', 'Re-run on new baseline');
  assert.equal(r.status, 'denied');
  // The earlier run kept its frozen policy snapshot.
  assert.equal((await svc.getRun(sam, baro)).policy?.policy?.version, 1);

  // A clean DAL C run takes the low-DAL policy.
  const [terr] = await svc.startAudits(marcus, { datasetId: ds, modules: ['TERR-DB'], layer2: 'heuristic' });
  assert.equal((await svc.getRun(marcus, terr)).approval.policyName, 'Clean low-DAL results');

  // Removing the last administrator is refused.
  await fail(svc.updateUser(sam, 'usr_sam', { roleIds: [], groupIds: [] }), /at least one active administrator/);

  // Schedules: every 24 hours, skip while pending, catch up once after downtime.
  const sch = await svc.saveSchedule(sam, { name: 'Nightly BARO', datasetId: ds, modules: ['BARO-*', 'ALT-ALERT'], recurrence: { kind: 'interval', everyMinutes: 1440 }, timezone: 'America/Phoenix', skipIfPending: true });
  assert.equal(sch.nextRunAt, '2026-10-04T15:00:00.000Z');
  assert.equal(await svc.tickSchedules(), 0);
  clock = new Date('2026-10-04T15:00:30Z');
  assert.equal(await svc.tickSchedules(), 1);
  let after = (await svc.listSchedules())[0];
  console.log('tick result:', after.lastError, after.lastRunIds);
  assert.equal(after.lastRunIds?.length, 2); assert.equal(after.nextRunAt, '2026-10-05T15:00:30.000Z');
  const schedRun = await svc.getRun(sam, after.lastRunIds![0]); assert.equal(schedRun.trigger, 'schedule'); assert.equal(schedRun.requestedByName, 'Sam Patel');
  clock = new Date('2026-10-09T15:00:00Z');                   // workers were down for 4 days
  await svc.tickSchedules();
  after = (await svc.listSchedules())[0];
  assert.equal(after.lastRunIds?.length ?? 0, 0, 'skipped because the earlier runs are still pending');
  assert.equal(after.nextRunAt, '2026-10-10T15:00:00.000Z', 'one catch-up, not four');
  const daily = await svc.saveSchedule(sam, { name: 'Daily 06:00', datasetId: ds, modules: ['*'], recurrence: { kind: 'daily', time: '06:00' }, timezone: 'America/Phoenix' });
  assert.equal(daily.nextRunAt, '2026-10-10T13:00:00.000Z');
  await fail(svc.saveSchedule(sam, { name: 'x', datasetId: ds, modules: ['*'], recurrence: { kind: 'cron', expr: '61 * * * *' }, timezone: 'UTC' }), /out of range/);
  await fail(svc.saveSchedule(marcus, { name: 'x', datasetId: ds, modules: ['*'], recurrence: { kind: 'daily', time: '06:00' }, timezone: 'UTC' }), /permission/);

  // API tokens act as their owner.
  const tok = await svc.createToken(marcus, { name: 'Jenkins nightly' });
  const tokActor = (await svc.actorFromToken(tok.token))!;
  assert.equal(tokActor.user.id, 'usr_marcus');
  const [viaApi] = await svc.startAudits(tokActor, { datasetId: ds, modules: ['FUEL-MON'] });
  assert.equal((await svc.getRun(sam, viaApi)).trigger, 'api');
  await svc.revokeToken(marcus, tok.id); assert.equal(await svc.actorFromToken(tok.token), null);

  // Audit log: intact, then tamper with one event and catch it.
  let v = await svc.verifyAuditLog(sam); assert.ok(v.ok); console.log(`audit log: ${v.checked} events, chain intact`);
  if (repo instanceof MemRepo) {
    repo.audit[5].details = { ...repo.audit[5].details, edited: true };
    v = await svc.verifyAuditLog(sam); assert.equal(v.ok, false); console.log('after tampering:', v.reason);
  } else {
    await assert.rejects(repo.pool.query("UPDATE audit_log SET details='{}' WHERE seq=5"), /append-only/);
    await assert.rejects(repo.pool.query('DELETE FROM audit_log WHERE seq=5'), /append-only/);
    console.log('database refused UPDATE and DELETE on audit_log');
    await repo.pool.end();
  }
  console.log('services: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
