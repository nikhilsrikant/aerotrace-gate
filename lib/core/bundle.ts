// Evidence bundle: the zip a program uploads so the agents audit real artifacts.
// Plain files engineers already produce (CSV, JUnit XML, C/Ada source, a checksum list), no proprietary tooling.
//
//   bundle.json                       { format, program, baseline, modules: [{ id, name, dal, src, entryPoints? }] }
//   requirements/hlr.csv              id,module,text
//   requirements/llr.csv              id,module,parent,text
//   design/elements.csv               id,module,couplings,text      (couplings = modules separated by ;)
//   src/**                            .c .h .adb .ads, trace tags as  /* Implements: LLR-X, LLR-Y */  and  /* @entry */
//   tests/*.xml                       JUnit; <property name="requirements"> and <property name="function">
//   coverage/coverage.csv             function,statement,decision,mcdc   (percent)
//   coverage/lcov.info                optional; statement and decision per function from DA/BRDA lines
//   cm/baseline.csv                   file,sha256
//   prs/problem_reports.csv           id,module,severity,status,files,title   (files separated by ;)
//   plans/**                          any documents (PSAC, SDP, SVP...), one record per file
//   truth.json                        optional; planted defects, only for measuring recall on test data
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { Corpus, DAL, Fn, TestCase, TestResult, Coverage, CMRecord, ProblemReport, HLR, LLR, DesignRecord, Module, PlanSection, PlantedDefect } from '../engine/types';
import { sha256 } from '../engine/crypto';

// ---------- CSV ----------
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(c => c !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(c => c !== '')) rows.push(row);
  const [head, ...body] = rows; if (!head) return [];
  const keys = head.map(h => h.trim().toLowerCase());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (head: string[], rows: unknown[][]) => [head.join(','), ...rows.map(r => r.map(esc).join(','))].join('\n') + '\n';

// ---------- export (synthetic corpus to bundle, also the reference for the format) ----------
export function renderFunction(f: Fn, thresholds: Map<string, number>, lineOf: (llr: string) => string | undefined): string {
  const lines = [`/* Implements: ${f.llrs.join(', ') || 'none'} */`];
  if (f.entry) lines.push('/* @entry */');
  const old = f.code.split('\n');
  const attr = old.find(l => l.includes('__attribute__((interrupt))')); if (attr) lines.push(attr);
  lines.push(old.find(l => l.startsWith('int ')) ?? `int ${f.id}(void)`, '{');
  f.llrs.forEach(l => { const ln = lineOf(l); if (ln) lines.push(ln, '        out->status = STATUS_FAILED;', '    }'); void thresholds; });
  f.calls.forEach(c => lines.push(`    ${c}(in, out);`));
  lines.push('    return OK;', '}');
  return lines.join('\n');
}

export async function exportBundle(c: Corpus, opts: { includeTruth?: boolean } = {}): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const put = (p: string, s: string) => { files[p] = strToU8(s); };
  const srcOf = (m: Module) => m.files[0].split('/').slice(0, 2).join('/') + '/';
  put('bundle.json', JSON.stringify({ format: 'aerotrace-bundle/1', program: c.program, baseline: c.baseline,
    modules: c.modules.map(m => ({ id: m.id, name: m.name, dal: m.dal, src: srcOf(m) })) }, null, 2));
  put('requirements/hlr.csv', toCsv(['id', 'module', 'text'], c.hlrs.map(h => [h.id, h.module, h.text])));
  put('requirements/llr.csv', toCsv(['id', 'module', 'parent', 'text'], c.llrs.map(l => [l.id, l.module, l.hlr, l.text])));
  put('design/elements.csv', toCsv(['id', 'module', 'couplings', 'text'], c.design.map(d => [d.id, d.module, d.couplings.join(';'), d.text])));
  // source: one file per path, functions in order
  const byFile = new Map<string, Fn[]>(); c.fns.forEach(f => { const l = byFile.get(f.file) ?? []; l.push(f); byFile.set(f.file, l); });
  const codeLine = new Map<string, string>();
  c.fns.forEach(f => f.code.split('\n').forEach(l => { const m = l.match(/\/\* (LLR-[A-Z0-9-]+) \*\//); if (m) codeLine.set(m[1] + '|' + f.id, l); }));
  const fileText = new Map<string, string>();
  for (const m of c.modules) for (const file of m.files) {
    const fns = byFile.get(file) ?? [];
    const text = `/* ${file} — ${m.name}, ${c.program}, baseline ${c.baseline} */\n#include "${m.id.toLowerCase().replace(/-/g, '_')}.h"\n\n` +
      fns.map(f => renderFunction(f, new Map(), l => codeLine.get(l + '|' + f.id))).join('\n\n') + '\n';
    fileText.set(file, text); put(file, text);
  }
  // tests as JUnit, one file per module
  const res = new Map(c.results.map(r => [r.test, r]));
  for (const m of c.modules) {
    const ts = c.tests.filter(t => t.module === m.id);
    const cases = ts.map(t => {
      const r = res.get(t.id);
      const status = !r ? '<skipped message="no result recorded on this baseline"/>' : r.status === 'FAIL' ? '<failure message="expected output not produced"/>' : '';
      return `  <testcase name="${t.id}" classname="${m.id}" time="0.01"><properties><property name="requirements" value="${t.llrs.join(',')}"/><property name="function" value="${t.fn}"/><property name="description" value="${t.text.replace(/"/g, '&quot;')}"/><property name="run" value="${r?.run ?? ''}"/></properties>${status}</testcase>`;
    }).join('\n');
    put(`tests/${m.id.toLowerCase()}.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${m.id}" tests="${ts.length}">\n${cases}\n</testsuite>\n`);
  }
  put('coverage/coverage.csv', toCsv(['function', 'statement', 'decision', 'mcdc'], c.coverage.map(v => [v.fn, v.stmt, v.dec, v.mcdc])));
  const cmRows: unknown[][] = [];
  for (const r of c.cm) { const real = await sha256(fileText.get(r.file) ?? ''); cmRows.push([r.file, r.actualSha === r.baselineSha ? real : r.baselineSha.padEnd(64, '0')]); }
  put('cm/baseline.csv', toCsv(['file', 'sha256'], cmRows));
  put('prs/problem_reports.csv', toCsv(['id', 'module', 'severity', 'status', 'files', 'title'], c.prs.map(p => [p.id, p.module, p.sev, p.status, p.files.join(';'), p.title])));
  put('plans/plans.csv', toCsv(['id', 'title'], c.plans.map(p => [p.id, p.title])));
  if (opts.includeTruth) put('truth.json', JSON.stringify(c.truth));
  put('README.txt', 'AeroTrace evidence bundle. Format described in lib/core/bundle.ts of the AeroTrace Gate repository.\n');
  return zipSync(files, { level: 6 });
}

// ---------- import ----------
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'case', 'else', 'do', 'goto', '__attribute__', 'interrupt', 'defined']);
const FN_HEAD = /^[ \t]*(?:[A-Za-z_][\w \t\*]*?[\s\*])([A-Za-z_]\w*)\s*\(([^;{}()]*)\)\s*\{/gm;
function lineAt(text: string, idx: number) { let n = 1; for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++; return n; }

export interface ImportResult { corpus: Corpus; warnings: string[] }
export async function importBundle(bytes: Uint8Array, opts: { maxFiles?: number } = {}): Promise<ImportResult> {
  const t0 = Date.now(); const warnings: string[] = [];
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('That file is not a valid zip archive.'); }
  const names = Object.keys(files).filter(n => !n.endsWith('/'));
  if (names.length > (opts.maxFiles ?? 200000)) throw new Error(`The bundle has ${names.length} files; the limit is ${opts.maxFiles ?? 200000}.`);
  // allow a single top-level folder inside the zip
  const root = names.includes('bundle.json') ? '' : (names.find(n => /^[^/]+\/bundle\.json$/.test(n))?.split('/')[0] + '/' || '');
  const get = (p: string) => { const f = files[root + p]; return f ? strFromU8(f) : null; };
  const list = (prefix: string) => names.filter(n => n.startsWith(root + prefix)).map(n => n.slice(root.length));
  const manifestText = get('bundle.json'); if (!manifestText) throw new Error('bundle.json is missing. See the sample bundle for the format.');
  let man: { program: string; baseline: string; modules: { id: string; name: string; dal: DAL; src: string; entryPoints?: string[] }[] };
  try { man = JSON.parse(manifestText); } catch (e) { throw new Error(`bundle.json is not valid JSON: ${(e as Error).message}`); }
  if (!man.program || !man.baseline || !Array.isArray(man.modules) || !man.modules.length) throw new Error('bundle.json needs program, baseline and at least one module.');
  for (const m of man.modules) { if (!m.id || !m.src) throw new Error('Every module in bundle.json needs an id and a src folder.'); if (!['A', 'B', 'C', 'D', 'E'].includes(m.dal)) throw new Error(`Module ${m.id} has DAL "${m.dal}"; use A, B, C, D or E.`); }
  const modIds = new Set(man.modules.map(m => m.id));
  const known = (mod: string, where: string) => { if (modIds.has(mod)) return true; warnings.push(`${where}: unknown module "${mod}", row skipped`); return false; };

  const hlrs: HLR[] = parseCsv(get('requirements/hlr.csv') ?? '').filter(r => r.id && known(r.module, 'hlr.csv')).map(r => ({ id: r.id, module: r.module, text: r.text }));
  const llrs: LLR[] = parseCsv(get('requirements/llr.csv') ?? '').filter(r => r.id && known(r.module, 'llr.csv')).map(r => ({ id: r.id, module: r.module, hlr: r.parent, text: r.text }));
  if (!hlrs.length) warnings.push('requirements/hlr.csv is missing or empty');
  if (!llrs.length) warnings.push('requirements/llr.csv is missing or empty');
  const design: DesignRecord[] = parseCsv(get('design/elements.csv') ?? '').filter(r => r.id && known(r.module, 'design/elements.csv'))
    .map(r => ({ id: r.id, module: r.module, couplings: r.couplings ? r.couplings.split(';').map(s => s.trim()).filter(Boolean) : [], text: r.text }));
  for (const m of man.modules) if (!design.some(d => d.module === m.id)) design.push({ id: `DES-${m.id}-auto`, module: m.id, couplings: [], text: 'No design elements supplied.' });

  // source
  const fns: Fn[] = []; const fileHash = new Map<string, string>(); const modules: Module[] = [];
  const srcFiles = list('').filter(n => /\.(c|h|adb|ads|cpp|hpp)$/i.test(n));
  for (const m of man.modules) {
    const mine = srcFiles.filter(f => f.startsWith(m.src));
    if (!mine.length) warnings.push(`No source files under ${m.src} for module ${m.id}`);
    modules.push({ id: m.id, name: m.name || m.id, dal: (m.dal === ('E' as DAL) ? 'D' : m.dal) as DAL, files: mine });
    for (const file of mine) {
      const text = get(file)!; fileHash.set(file, await sha256(text));
      FN_HEAD.lastIndex = 0; let mt: RegExpExecArray | null;
      while ((mt = FN_HEAD.exec(text))) {
        const name = mt[1]; if (CONTROL.has(name)) continue;
        const open = mt.index + mt[0].length - 1; let depth = 0, end = open;
        for (let i = open; i < text.length; i++) { const ch = text[i]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (!depth) { end = i; break; } } }
        // the comment block right above the signature, stopping at the previous function or statement
        const lineStart = text.lastIndexOf('\n', mt.index - 1) + 1;
        const above = text.slice(Math.max(0, lineStart - 2000), lineStart).split('\n'); above.pop();
        let cut = above.length; while (cut > 0 && cut > above.length - 12) { const t = above[cut - 1].trim(); if (t === '}' || t.endsWith(';') || t.startsWith('#')) break; cut--; }
        const headLines = above.slice(cut).join('\n');
        const tag = [...headLines.matchAll(/Implements:\s*([^*]*)\*\//g)].pop();
        const llrIds = tag ? tag[1].split(',').map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'none') : [];
        const body = text.slice(open + 1, end);
        const calls = [...new Set([...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(x => x[1]).filter(x => !CONTROL.has(x)))];
        const firstHead = above.slice(cut).findIndex(l => l.trim() !== '');
        const headText = firstHead < 0 ? '' : above.slice(cut + firstHead).join('\n') + '\n';
        const code = headText + text.slice(lineStart, end + 1);
        fns.push({ id: name, module: m.id, file, start: lineAt(text, mt.index), end: lineAt(text, end), llrs: llrIds, calls,
          entry: /@entry/.test(headLines) || (m.entryPoints ?? []).includes(name), code });
        FN_HEAD.lastIndex = end + 1;
      }
    }
  }
  const dupes = fns.filter((f, i) => fns.findIndex(g => g.id === f.id) !== i);
  if (dupes.length) warnings.push(`${dupes.length} function names appear more than once; the first definition is used for tracing`);

  // tests (JUnit)
  const tests: TestCase[] = []; const results: TestResult[] = [];
  for (const file of list('tests/').filter(n => n.endsWith('.xml'))) {
    const xml = get(file)!;
    for (const tc of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = tc[1], inner = tc[3] ?? '';
      const attr = (k: string) => (attrs.match(new RegExp(`\\b${k}="([^"]*)"`)) ?? [])[1] ?? '';
      const prop = (k: string) => (inner.match(new RegExp(`<property\\s+name="${k}"\\s+value="([^"]*)"`)) ?? [])[1] ?? '';
      const id = attr('name'); if (!id) continue;
      const module = modIds.has(attr('classname')) ? attr('classname') : fns.find(f => f.id === prop('function'))?.module ?? '';
      if (!known(module, file)) continue;
      const llrList = prop('requirements').split(',').map(s => s.trim()).filter(Boolean);
      if (!llrList.length) warnings.push(`${file}: ${id} lists no requirements`);
      tests.push({ id, module, llrs: llrList, fn: prop('function'), text: prop('description').replace(/&quot;/g, '"') || id });
      if (/<skipped\b/.test(inner)) continue;
      results.push({ test: id, status: /<(failure|error)\b/.test(inner) ? 'FAIL' : 'PASS', baseline: man.baseline, run: prop('run') || 'unknown' });
    }
  }

  // coverage
  const coverage = new Map<string, Coverage>();
  const lcov = get('coverage/lcov.info');
  if (lcov) {
    let file = ''; const da = new Map<string, Map<number, number>>(); const br = new Map<string, { line: number; taken: boolean }[]>();
    for (const line of lcov.split('\n')) {
      if (line.startsWith('SF:')) { file = line.slice(3).trim(); if (!da.has(file)) { da.set(file, new Map()); br.set(file, []); } }
      else if (line.startsWith('DA:')) { const [l, h] = line.slice(3).split(',').map(Number); da.get(file)!.set(l, h); }
      else if (line.startsWith('BRDA:')) { const [l, , , t] = line.slice(5).split(','); br.get(file)!.push({ line: +l, taken: t !== '-' && +t > 0 }); }
    }
    for (const f of fns) {
      const key = [...da.keys()].find(k => k.endsWith(f.file)); if (!key) continue;
      const lines = [...da.get(key)!].filter(([l]) => l >= f.start && l <= f.end); const brs = br.get(key)!.filter(b => b.line >= f.start && b.line <= f.end);
      const pct = (a: number, b: number) => (b ? Math.round(a / b * 100) : 100);
      coverage.set(f.id, { fn: f.id, stmt: pct(lines.filter(([, h]) => h > 0).length, lines.length), dec: pct(brs.filter(b => b.taken).length, brs.length), mcdc: 100 });
    }
  }
  for (const r of parseCsv(get('coverage/coverage.csv') ?? '')) {
    if (!r.function) continue; const prev = coverage.get(r.function);
    const n = (v: string, d: number) => (v === '' || v === undefined ? d : Math.max(0, Math.min(100, Number(v))));
    coverage.set(r.function, { fn: r.function, stmt: n(r.statement, prev?.stmt ?? 100), dec: n(r.decision, prev?.dec ?? 100), mcdc: n(r.mcdc, prev?.mcdc ?? 100) });
  }
  if (!coverage.size) warnings.push('No coverage data (coverage/coverage.csv or coverage/lcov.info); structural coverage was not checked');

  // configuration
  const cm: CMRecord[] = [];
  const base = parseCsv(get('cm/baseline.csv') ?? '');
  if (!base.length) warnings.push('cm/baseline.csv is missing; baseline integrity was not checked');
  for (const r of base) {
    const mod = modules.find(m => m.files.includes(r.file));
    if (!mod) { warnings.push(`cm/baseline.csv lists ${r.file}, which is not in the bundle`); continue; }
    cm.push({ file: r.file, module: mod.id, baselineSha: (r.sha256 || '').toLowerCase(), actualSha: fileHash.get(r.file)! });
  }
  const prs: ProblemReport[] = parseCsv(get('prs/problem_reports.csv') ?? '').filter(r => r.id && known(r.module, 'problem_reports.csv')).map(r => ({
    id: r.id, module: r.module, sev: (Math.min(3, Math.max(1, Number(r.severity) || 3))) as 1 | 2 | 3, status: /open/i.test(r.status) ? 'OPEN' : 'CLOSED',
    files: r.files ? r.files.split(';').map(s => s.trim()) : [], title: r.title || r.id }));
  const planCsv = parseCsv(get('plans/plans.csv') ?? '');
  const plans: PlanSection[] = planCsv.length ? planCsv.map(r => ({ id: r.id, title: r.title, text: r.title }))
    : list('plans/').map((p, i) => ({ id: `PLAN-${i + 1}`, title: p.slice(6), text: p.slice(6) }));
  let truth: PlantedDefect[] = []; const tj = get('truth.json'); if (tj) { try { truth = JSON.parse(tj); } catch { warnings.push('truth.json is not valid JSON; ignored'); } }

  const counts = { 'High-level reqs': hlrs.length, 'Low-level reqs': llrs.length, 'Design records': design.length, 'Source functions': fns.length,
    'Test cases': tests.length, 'Test results': results.length, 'Coverage records': coverage.size, 'Problem reports': prs.length, 'Config records': cm.length, 'Plans and standards': plans.length };
  const corpus: Corpus = { program: man.program, baseline: man.baseline, seed: 0, modules, hlrs, llrs, design, fns, tests, results, coverage: [...coverage.values()],
    prs, cm, plans, truth, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), generatedMs: Date.now() - t0 };
  return { corpus, warnings: warnings.slice(0, 200) };
}
