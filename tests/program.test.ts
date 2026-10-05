// Program readiness, blockers, the unblock plan, what-if projections and chaos drills.
import assert from 'node:assert/strict';
import { MemRepo } from '../lib/core/memRepo';
import { Services } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { sha256 } from '../lib/engine';
import { projectVerdict } from '../lib/core/program';
import { CHAOS_PRESETS, checkDrill, type ChaosPreset } from '../lib/core/chaos';

(async () => {
  const repo = new MemRepo();
  const svc = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true });
  const s = await seed(repo, svc, { demoUsers: true, syntheticDataset: true, hash: p => sha256(p) });
  const sam = await svc.actorFor((await repo.getUser('usr_sam'))!);

  // Before anything runs: every module is "not audited" and the program can't be YES.
  let p = await svc.programOverview(sam);
  assert.equal(p.counts.modules, 40); assert.equal(p.counts.notAudited, 40); assert.equal(p.program.verdict, 'CONDITIONAL');

  // Audit every module.
  await svc.startAudits(sam, { datasetId: s.datasetId!, modules: ['*'], layer2: 'heuristic' });
  p = await svc.programOverview(sam);
  const c = p.counts;
  assert.equal(c.YES + c.CONDITIONAL + c.NO + c.notAudited + c.running + c.failed, 40);
  assert.equal(c.notAudited, 0);
  assert.equal(p.program.verdict, c.NO ? 'NO' : 'CONDITIONAL');
  console.log(`program ${p.program.verdict}: ${c.NO} NO, ${c.CONDITIONAL} conditional, ${c.YES} YES`);

  // Agents: one health row each, latency series present; the flow matrix accounts for every message.
  assert.equal(p.agents.length, 5); assert.ok(p.agents.every(a => a.runs === 40 && a.series.length > 0));
  assert.equal(p.flow.cells.reduce((n, x) => n + x.count, 0), p.flow.total);

  // Blockers are ranked: critical path first, then severity.
  for (let i = 1; i < p.blockers.length; i++) {
    const a = p.blockers[i - 1], b = p.blockers[i];
    assert.ok(Number(a.onCriticalPath) > Number(b.onCriticalPath) || (a.onCriticalPath === b.onCriticalPath && a.severity <= b.severity), `rank at ${i}`);
  }
  assert.ok(p.blockers.every(b => b.verdict !== 'YES'));

  // The unblock plan only ever improves things as owners are added, and ends with fewer NO modules.
  assert.ok(p.plan.length > 0);
  for (let i = 1; i < p.plan.length; i++) assert.ok(p.plan[i].NO <= p.plan[i - 1].NO, 'NO count never rises');
  assert.ok(p.plan.at(-1)!.NO < c.NO, 'clearing the planned owners moves NO modules');
  console.log('plan:', p.plan.map(x => `${x.owners.join(', ')} -> ${x.NO} NO / ${x.CONDITIONAL} COND / ${x.YES} YES`).join(' | '));

  // What-if on one NO module: fixing every finding kind gives YES; fixing nothing changes nothing.
  const no = p.modules.find(m => m.verdict === 'NO')!;
  const run = (await repo.getRun(no.runId!, { withResult: true }))!.result!;
  assert.equal(projectVerdict(run, []).verdict, 'NO');
  const allKinds = [...new Set(run.findings.filter(f => f.status === 'confirmed').map(f => f.kind))];
  assert.equal(projectVerdict(run, allKinds).verdict, 'YES');

  // Chaos drills: every preset behaves as its own scorecard says.
  for (const id of Object.keys(CHAOS_PRESETS) as ChaosPreset[]) {
    const { runId } = await svc.chaosDrill(sam, { module: 'BARO-IN', preset: id });
    const r = (await repo.getRun(runId, { withResult: true }))!.result!;
    const checks = checkDrill(CHAOS_PRESETS[id].faults, r);
    assert.ok(checks.every(x => x.ok), `${id}: ${JSON.stringify(checks.filter(x => !x.ok))}`);
    console.log(`drill ${id}: ${checks.length} checks pass (verdict ${r.verdict}, complete ${r.complete})`);
  }
  assert.ok((await svc.auditLog(sam, 500)).some(e => e.action === 'chaos.drill'));
  console.log('program: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
