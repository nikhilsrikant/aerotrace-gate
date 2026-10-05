// Exercises the LLM code path with a fake model, including one made-up citation the cross-check must reject.
import { generateCorpus, runAudit, type LLMClient } from '../lib/engine';
import assert from 'node:assert/strict';
(async () => {
  const c = generateCorpus();
  const amb = c.llrs.find(l => l.module === 'ALT-ALERT' && /should/.test(l.text))!;
  const fake: LLMClient = { available: true, async complete(system, user) {
    if (system.includes('low-level requirements')) return JSON.stringify([
      { id: amb.id, quote: 'should', reason: 'Uses should.' },
      { id: 'LLR-ALT-9999', quote: 'quickly', reason: 'Made up by the model.' }]);
    if (system.includes('never-called')) { const fn = user.match(/--- (isr_\S+)/)?.[1]; return JSON.stringify(fn ? [{ fn, dead: false, quote: '__attribute__((interrupt))', reason: 'ISR.' }] : []); }
    return '[]';
  } };
  const r = await runAudit(c, { module: 'ALT-ALERT', layer2: 'llm' }, { llm: fake });
  const l2 = r.findings.filter(f => f.layer === 'L2');
  console.log(`mode=${r.layer2Mode} llmCalls=${r.stats.llmCalls} L2=${l2.length} rejected=${r.stats.rejected} disputed=${r.stats.disputed}`);
  assert.equal(r.layer2Mode, 'llm'); assert.equal(r.stats.rejected, 1); assert.equal(r.stats.disputed, 1);
  assert.ok(l2.some(f => f.status === 'confirmed' && f.ref === amb.id));
  console.log('rejected reason:', l2.find(f => f.status === 'rejected')!.dispute);
  console.log('llm path ok');
})().catch(e => { console.error(e); process.exit(1); });
