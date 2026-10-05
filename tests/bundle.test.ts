// Round trip: synthetic corpus -> evidence bundle zip -> importer -> same audit results. Proves the importer reads real-shaped files.
import assert from 'node:assert/strict';
import { generateCorpus, runAudit } from '../lib/engine';
import { exportBundle, importBundle, parseCsv } from '../lib/core/bundle';

(async () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n'), [{ a: 'x, y', b: 'he said "hi"' }]);
  const c = generateCorpus();
  const t0 = Date.now();
  const zip = await exportBundle(c, { includeTruth: true });
  console.log(`exported ${c.total} records to a ${(zip.byteLength / 1024 / 1024).toFixed(1)} MB zip in ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const { corpus: back, warnings } = await importBundle(zip);
  console.log(`imported in ${Date.now() - t1} ms: ${back.fns.length} functions, ${back.tests.length} tests, ${back.results.length} results, ${back.cm.length} baseline files; ${warnings.length} warnings`);
  if (warnings.length) console.log(warnings.slice(0, 5));
  for (const k of ['hlrs', 'llrs', 'fns', 'tests', 'results', 'prs', 'cm'] as const) assert.equal(back[k].length, c[k].length, `${k} count`);
  let same = 0;
  for (const m of c.modules) {
    const a = await runAudit(c, { module: m.id, layer2: 'heuristic' }), b = await runAudit(back, { module: m.id, layer2: 'heuristic' });
    const key = (r: typeof a) => r.findings.filter(f => f.status === 'confirmed').map(f => `${f.kind}|${f.ref}`).sort().join('\n');
    if (a.verdict === b.verdict && key(a) === key(b)) same++;
    else { console.log(m.id, a.verdict, b.verdict, 'only-original:', a.findings.filter(f => !b.findings.some(g => g.kind === f.kind && g.ref === f.ref)).map(f => f.kind + ' ' + f.ref).slice(0, 4), 'only-import:', b.findings.filter(f => !a.findings.some(g => g.kind === f.kind && g.ref === f.ref)).map(f => f.kind + ' ' + f.ref).slice(0, 4)); }
  }
  console.log(`${same}/${c.modules.length} modules give identical verdicts and findings after the round trip`);
  assert.equal(same, c.modules.length);
  await assert.rejects(importBundle(new Uint8Array([1, 2, 3])), /not a valid zip/);
  console.log('bundle: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
