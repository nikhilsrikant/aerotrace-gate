// Runs the real engine on the full 50,000-record corpus and checks it against the planted ground truth.
import { generateCorpus, runAudit, verifyChain } from '../lib/engine';
import assert from 'node:assert/strict';

(async () => {
  const c = generateCorpus();
  console.log(`corpus: ${c.total} records in ${c.generatedMs} ms, ${c.truth.length} planted items`);
  assert.equal(c.total, 50000);
  const expect: Record<string, string> = { 'ALT-ALERT': 'CONDITIONAL', 'BARO-IN': 'NO', 'TERR-DB': 'YES' };
  for (const m of Object.keys(expect)) {
    const r = await runAudit(c, { module: m, layer2: 'heuristic' });
    console.log(`${m}: ${r.verdict} | L1 ${r.stats.l1} L2 ${r.stats.l2} disputed ${r.stats.disputed} | recall ${(r.stats.recall * 100).toFixed(1)}% (${r.stats.caught}/${r.stats.planted}) | ${r.stats.messages} msgs | ${r.durationMs} ms`);
    assert.equal(r.verdict, expect[m]); assert.ok(r.chainValid); assert.ok(await verifyChain(r.messages));
    assert.ok(r.stats.recall >= 0.9, 'recall below 90%');
  }
  let total = 0, caught = 0;
  for (const mod of c.modules) { const r = await runAudit(c, { module: mod.id, layer2: 'heuristic' }); total += r.stats.planted; caught += r.stats.caught; }
  console.log(`program-wide recall: ${(caught / total * 100).toFixed(1)}% (${caught}/${total}) across ${c.modules.length} modules`);
  const off = await runAudit(c, { module: 'TERR-DB', layer2: 'heuristic', faults: { Design: 'offline' } });
  console.log(`TERR-DB with Design offline: ${off.verdict} | complete=${off.complete} | ${off.verdictReason}`);
  assert.equal(off.verdict, 'CONDITIONAL'); assert.equal(off.complete, false);
  const flaky = await runAudit(c, { module: 'ALT-ALERT', layer2: 'heuristic', faults: { Testing: 'flaky' } });
  const t = flaky.health.find(h => h.agent === 'Testing')!;
  console.log(`flaky Testing: state=${t.state} retries=${t.retries} verdict=${flaky.verdict}`);
  assert.equal(t.state, 'degraded');
  const bad = await runAudit(c, { module: 'ALT-ALERT', layer2: 'heuristic', faults: { Code: 'malformed' } });
  console.log(`malformed Code: ${bad.stats.rejectedMessages} messages rejected: ${bad.messages.filter(m => !m.accepted).map(m => m.reason).join(' | ')}`);
  assert.equal(bad.stats.rejectedMessages, 2);
  console.log('all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
