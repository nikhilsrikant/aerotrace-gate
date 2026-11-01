// Synthetic DO-178C program: 50,000 linked records with defects planted on purpose.
// Deterministic for a given seed, so every run and every teammate sees the same corpus.
import type {
  Corpus, DAL, Module, HLR, LLR, DesignRecord, Fn, TestCase, TestResult, Coverage,
  ProblemReport, CMRecord, PlanSection, PlantedDefect, DefectKind,
} from './types';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const MODULES: [string, string, string][] = [
  ['ALT-ALERT', 'ALT', 'Altitude alerting'], ['BARO-IN', 'BAR', 'Barometric input'], ['TERR-DB', 'TER', 'Terrain database'],
  ['AIR-DATA', 'ADC', 'Air data computation'], ['AUTOTHR', 'ATH', 'Autothrottle'], ['FLT-PLAN', 'FPL', 'Flight plan manager'],
  ['NAV-FUSE', 'NAV', 'Navigation sensor fusion'], ['VNAV', 'VNV', 'Vertical navigation'], ['LNAV', 'LNV', 'Lateral navigation'],
  ['RAD-ALT', 'RAD', 'Radio altimeter interface'], ['WX-RADAR', 'WXR', 'Weather radar interface'], ['XPDR-IF', 'XPD', 'Transponder interface'],
  ['EGPWS-IF', 'EGP', 'EGPWS interface'], ['FUEL-MON', 'FUL', 'Fuel monitoring'], ['ENG-IND', 'ENG', 'Engine indication'],
  ['CAS-MGR', 'CAS', 'Crew alerting'], ['PFD-DRV', 'PFD', 'Primary flight display driver'], ['MFD-DRV', 'MFD', 'Multifunction display driver'],
  ['ARINC-429', 'A42', 'ARINC 429 bus'], ['AFDX-NET', 'AFX', 'AFDX network'], ['BITE', 'BIT', 'Built-in test'],
  ['MAINT-LOG', 'MNT', 'Maintenance log'], ['NVM-STORE', 'NVM', 'Non-volatile storage'], ['TIME-SYNC', 'TIM', 'Time synchronisation'],
  ['GPS-RCV', 'GPS', 'GPS receiver interface'], ['IRS-IF', 'IRS', 'Inertial reference interface'], ['AOA-MON', 'AOA', 'Angle of attack monitor'],
  ['STALL-WARN', 'STW', 'Stall warning'], ['TRIM-CTL', 'TRM', 'Trim control'], ['FLAP-POS', 'FLP', 'Flap position'],
  ['GEAR-IND', 'GER', 'Landing gear indication'], ['CABIN-PRS', 'CAB', 'Cabin pressure'], ['ICE-DET', 'ICE', 'Ice detection'],
  ['AP-MODE', 'APM', 'Autopilot mode logic'], ['FD-CMD', 'FDC', 'Flight director commands'], ['YAW-DAMP', 'YAW', 'Yaw damper'],
  ['COMM-MGR', 'COM', 'Communications manager'], ['DATALINK', 'DLK', 'Datalink'], ['CHECKLIST', 'CHK', 'Electronic checklist'],
  ['PERF-CALC', 'PRF', 'Performance calculation'],
];
const CLEAN = new Set([2, 21, 38]);
const profile = (i: number) => CLEAN.has(i) ? 'clean' : (i === 1 || (i > 3 && i % 3 === 1)) ? 'major' : 'minor';

const VERBS = ['compute', 'validate', 'publish', 'latch', 'filter', 'select', 'monitor', 'report', 'reset', 'limit'];
const OBJECTS = ['the altitude source', 'the input frame', 'the alert state', 'the output word', 'the fault counter',
  'the display label', 'the sensor status', 'the mode flag', 'the timer value', 'the health word'];
const CONDS = ['a new frame is received', 'the input is out of range', 'power-up completes', 'the mode changes',
  'the watchdog expires', 'the bus reports a parity error', 'the crew acknowledges the alert', 'the value is stale'];
const VAGUE = ['as appropriate', 'quickly', 'TBD', 'where practical', 'in a timely manner'];
const PLAN_TITLES = ['PSAC', 'SDP', 'SVP', 'SCMP', 'SQAP', 'Coding standard', 'Design standard', 'Requirements standard'];

export interface GenerateOptions { seed?: number; total?: number }

export function generateCorpus(opts: GenerateOptions = {}): Corpus {
  const t0 = Date.now();
  const seed = opts.seed ?? 178;
  const rnd = mulberry32(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const sha = () => Array.from({ length: 16 }, () => Math.floor(rnd() * 16).toString(16)).join('');

  const modules: Module[] = []; const hlrs: HLR[] = []; const llrs: LLR[] = []; const design: DesignRecord[] = [];
  const fns: Fn[] = []; const tests: TestCase[] = []; const results: TestResult[] = []; const coverage: Coverage[] = [];
  const prs: ProblemReport[] = []; const cm: CMRecord[] = []; const truth: PlantedDefect[] = [];
  const baseline = 'a3f9c1';
  const plant = (kind: DefectKind, module: string, ref: string) => truth.push({ kind, module, ref });

  const FILES = 37, FNS = 150, HL = 75, LL = 250, DES = 25, PRN = 50;
  const dalFor = (i: number, p: string): DAL => i === 0 ? 'B' : i === 1 ? 'A' : i === 2 ? 'C'
    : p === 'major' ? (rnd() < 0.5 ? 'A' : 'B') : p === 'minor' ? pick(['B', 'C', 'C', 'D'] as DAL[]) : pick(['A', 'B', 'C'] as DAL[]);

  MODULES.forEach(([name, code, title], mi) => {
    const p = profile(mi);
    const dal = dalFor(mi, p);
    const low = name.toLowerCase().replace(/-/g, '_');
    const files = Array.from({ length: FILES + (mi % 2) }, (_, k) => `src/${low}/${low}_${String(k + 1).padStart(2, '0')}.c`);
    const mod: Module = { id: name, name: title, dal, files };
    modules.push(mod);
    const major = p === 'major', clean = p === 'clean';
    const n = (k: number) => clean ? 0 : k;

    // Requirements
    const mh: HLR[] = Array.from({ length: HL }, (_, k) => ({ id: `HLR-${code}-${String(k + 1).padStart(3, '0')}`, module: name,
      text: `The ${title.toLowerCase()} function shall ${pick(VERBS)} ${pick(OBJECTS)} when ${pick(CONDS)}.` }));
    hlrs.push(...mh);
    const thresholdFor = new Map<string, number>();
    const ml: LLR[] = Array.from({ length: LL }, (_, k) => {
      const id = `LLR-${code}-${String(k + 1).padStart(4, '0')}`;
      let text = `When ${pick(CONDS)}, the software shall ${pick(VERBS)} ${pick(OBJECTS)}`;
      if (k % 5 === 0) { const th = int(2, 8); thresholdFor.set(id, th); text += ` after ${th} consecutive frames`; }
      return { id, module: name, hlr: mh[k % HL].id, text: text + '.' };
    });
    // HLR without children: move their LLRs to the next HLR
    const noChild = new Set<string>();
    for (let k = 0; k < n(2); k++) { const h = mh[int(0, HL - 2)]; if (noChild.has(h.id)) continue; noChild.add(h.id); plant('HLR_NO_LLR', name, h.id); }
    ml.forEach(l => { if (noChild.has(l.hlr)) { let idx = mh.findIndex(h => h.id === l.hlr); do { idx = (idx + 1) % HL; } while (noChild.has(mh[idx].id)); l.hlr = mh[idx].id; } });
    for (let k = 0; k < n(2); k++) { const l = ml[int(1, LL - 1)]; if (l.hlr.endsWith('-999')) continue; l.hlr = `HLR-${code}-999`; plant('LLR_ORPHAN', name, l.id); }
    for (let k = 0; k < n(6); k++) {
      const l = ml[int(1, LL - 1)]; if (thresholdFor.has(l.id) || /should|TBD/.test(l.text)) continue;
      const v = pick(VAGUE); l.text = v === 'TBD' ? l.text.replace(/\.$/, ' within TBD ms.') : l.text.replace('shall', 'should') .replace(/\.$/, ` ${v}.`);
      plant('REQ_AMBIGUOUS', name, l.id);
    }
    llrs.push(...ml);

    // Code
    const mf: Fn[] = Array.from({ length: FNS }, (_, k) => {
      const file = files[k % files.length];
      const start = 20 + Math.floor(k / files.length) * 48 + int(0, 6);
      return { id: `${low}_${pick(VERBS)}_${String(k + 1).padStart(3, '0')}`, module: name, file, start, end: start + int(14, 40),
        llrs: [], calls: [], entry: k < 5, code: '' };
    });
    ml.forEach((l, k) => mf[k % FNS].llrs.push(l.id));
    for (let k = 5; k < FNS; k++) mf[int(0, k - 1)].calls.push(mf[k].id);
    for (let k = 0; k < n(3); k++) { const f = mf[int(10, FNS - 1)]; if (!f.llrs.length) continue; mf[(mf.indexOf(f) + 1) % FNS].llrs.push(...f.llrs); f.llrs = []; plant('FN_NO_LLR', name, f.id); }
    for (let k = 0; k < n(2); k++) { const f = mf[int(10, FNS - 1)]; const bad = `LLR-${code}-${int(7000, 7999)}`; f.llrs.push(bad); plant('FN_BAD_TAG', name, f.id); }
    for (let k = 0; k < n(3); k++) {
      const f = mf[int(20, FNS - 1)]; if (f.entry || truth.some(t => t.ref === f.id)) continue;
      mf.forEach(g => { g.calls = g.calls.filter(c => c !== f.id); });
      f.calls.forEach(c => { if (!mf.some(g => g !== f && g.calls.includes(c))) mf[0].calls.push(c); });
      plant('DEAD_CODE', name, f.id);
    }
    if (!clean) { // an interrupt handler: never called from C, registered in the vector table
      const f = mf[FNS - 1]; mf.forEach(g => { g.calls = g.calls.filter(c => c !== f.id); }); f.id = `isr_${low}_rx`; plant('ISR_FALSE_DEAD', name, f.id);
    }
    // threshold in code, sometimes wrong
    const mismatch = new Set<string>();
    for (let k = 0; k < n(4); k++) { const id = pick([...thresholdFor.keys()]); if (!mismatch.has(id)) { mismatch.add(id); plant('CODE_REQ_MISMATCH', name, id); } }
    mf.forEach(f => {
      const lines = [`/* Implements: ${f.llrs.join(', ') || 'none'} */`];
      if (f.id.startsWith('isr_')) lines.push('__attribute__((interrupt)) /* vector table slot 14 */');
      lines.push(`int ${f.id}(const ${low}_in_t *in, ${low}_out_t *out)`, '{');
      f.llrs.forEach(l => { const th = thresholdFor.get(l); if (th) { const v = mismatch.has(l) ? th + int(1, 3) : th; lines.push(`    if (in->bad_frames >= ${v}) {   /* ${l} */`, '        out->status = STATUS_FAILED;', '    }'); } });
      f.calls.slice(0, 3).forEach(c => lines.push(`    ${c}(in, out);`));
      lines.push('    return OK;', '}');
      f.code = lines.join('\n');
    });
    fns.push(...mf);

    // Design + couplings
    const others = MODULES.map(m => m[0]).filter(m => m !== name);
    const couplings = Array.from(new Set([pick(others), pick(others), pick(others)]));
    for (let k = 0; k < DES; k++) design.push({ id: `DES-${code}-${String(k + 1).padStart(3, '0')}`, module: name,
      couplings: k === 0 ? couplings : [], text: `${title}: interface element ${k + 1}${k === 0 ? `, coupled to ${couplings.join(', ')}` : ''}.` });
    couplings.forEach((c, k) => { const f = mf[10 + k * 7]; f.calls.push(`${c.toLowerCase().replace(/-/g, '_')}_get_status`); });
    for (let k = 0; k < n(2); k++) {
      const target = others.find(o => !couplings.includes(o) && rnd() < 0.2) ?? others.find(o => !couplings.includes(o))!;
      const f = mf[30 + k * 11]; f.calls.push(`${target.toLowerCase().replace(/-/g, '_')}_get_status`); f.code = f.code.replace('    return OK;', `    ${target.toLowerCase().replace(/-/g, '_')}_get_status(in, out);\n    return OK;`);
      plant('COUPLING_UNDOC', name, `${f.id}->${target}`);
    }

    // Tests, results, coverage
    const mt: TestCase[] = ml.map((l, k) => ({ id: `TC-${code}-${String(k + 1).padStart(4, '0')}`, module: name, llrs: [l.id],
      fn: mf[k % FNS].id, text: `Drive ${l.id}: inject "${CONDS[k % CONDS.length]}" and check the expected output.` }));
    for (let k = 0; k < n(4); k++) { const t = mt[int(1, LL - 1)]; const prev = t.llrs[0]; if (truth.some(d => d.ref === prev)) continue; t.llrs = [mt[(mt.indexOf(t) + 1) % LL].llrs[0]]; plant('LLR_NO_TEST', name, prev); }
    tests.push(...mt);
    const noResult = new Set<string>(); const failing = new Set<string>();
    for (let k = 0; k < n(3); k++) { const t = pick(mt); if (!noResult.has(t.id)) { noResult.add(t.id); plant('TEST_NO_RESULT', name, t.id); } }
    if (major) for (let k = 0; k < 4; k++) { const t = pick(mt); if (!noResult.has(t.id) && !failing.has(t.id)) { failing.add(t.id); plant('TEST_FAIL', name, t.id); } }
    mt.forEach(t => { if (!noResult.has(t.id)) results.push({ test: t.id, status: failing.has(t.id) ? 'FAIL' : 'PASS', baseline, run: '2026-09-30' }); });
    const gap = new Set<string>();
    for (let k = 0; k < (dal === 'D' ? 0 : n(5)); k++) { const f = pick(mf); if (!gap.has(f.id)) { gap.add(f.id); plant('COVERAGE_GAP', name, f.id); } }
    mf.forEach(f => {
      const low = gap.has(f.id); const c = { fn: f.id, stmt: 100, dec: 100, mcdc: 100 };
      if (low) { if (dal === 'A') c.mcdc = int(84, 97); else if (dal === 'B') c.dec = int(86, 97); else c.stmt = int(88, 98); }
      coverage.push(c);
    });

    // Problem reports
    for (let k = 0; k < PRN; k++) prs.push({ id: `PR-${code}-${String(k + 1).padStart(3, '0')}`, module: name, sev: pick([2, 3, 3] as (2 | 3)[]),
      status: 'CLOSED', files: [pick(files)], title: `${title}: ${pick(['label overlap', 'stale value after reset', 'log spam', 'timing margin', 'typo in comment'])}` });
    const modPrs = prs.slice(-PRN);
    if (!clean) {
      const openN = major ? 3 : 2;
      for (let k = 0; k < openN; k++) { const pr = modPrs[k * 9]; pr.status = 'OPEN'; pr.sev = major && k === 0 ? 1 : (k % 2 ? 3 : 2); if (pr.sev === 1) pr.title = `${title}: CRC check skipped on frame wrap-around`; plant('OPEN_PR', name, pr.id); }
    }

    // Configuration records
    files.forEach(f => { const s = sha(); cm.push({ file: f, module: name, baselineSha: s, actualSha: s }); });
    if (major) for (let k = 0; k < 2; k++) { const r = cm[cm.length - 1 - k * 5]; r.actualSha = sha(); plant('CHECKSUM_MISMATCH', name, r.file); }
  });

  const used = hlrs.length + llrs.length + design.length + fns.length + tests.length + results.length + coverage.length + prs.length + cm.length;
  const target = opts.total ?? 50000;
  const plans: PlanSection[] = Array.from({ length: Math.max(0, target - used) }, (_, k) => {
    const t = PLAN_TITLES[k % PLAN_TITLES.length];
    return { id: `PLAN-${String(k + 1).padStart(4, '0')}`, title: `${t} §${Math.floor(k / PLAN_TITLES.length) + 1}`, text: `${t} section ${Math.floor(k / PLAN_TITLES.length) + 1}.` };
  });
  const counts = { 'High-level reqs': hlrs.length, 'Low-level reqs': llrs.length, 'Design records': design.length, 'Source functions': fns.length,
    'Test cases': tests.length, 'Test results': results.length, 'Coverage records': coverage.length, 'Problem reports': prs.length,
    'Config records': cm.length, 'Plans and standards': plans.length };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { program: 'ALT-ALERT FMS', baseline, seed, modules, hlrs, llrs, design, fns, tests, results, coverage, prs, cm, plans,
    truth, counts, total, generatedMs: Date.now() - t0 };
}
