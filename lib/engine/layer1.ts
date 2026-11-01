// Layer 1: deterministic rules over the trace graph. Same input, same findings, every time.
import type { Corpus, Finding, AgentName, Severity, DefectKind, Citation, Module } from './types';

export interface Index {
  hlrById: Map<string, Corpus['hlrs'][number]>; llrById: Map<string, Corpus['llrs'][number]>;
  fnById: Map<string, Corpus['fns'][number]>; llrChildren: Map<string, number>; testedLlrs: Set<string>;
  callers: Map<string, number>; resultByTest: Map<string, Corpus['results'][number]>;
  covByFn: Map<string, Corpus['coverage'][number]>; couplingsByModule: Map<string, Set<string>>;
  moduleByPrefix: Map<string, string>; byModule: Map<string, ModuleSlice>;
}
export interface ModuleSlice {
  module: Module; hlrs: Corpus['hlrs']; llrs: Corpus['llrs']; fns: Corpus['fns']; tests: Corpus['tests'];
  prs: Corpus['prs']; cm: Corpus['cm']; design: Corpus['design'];
}

const cache = new WeakMap<Corpus, Index>();
export function buildIndex(c: Corpus): Index {
  const hit = cache.get(c); if (hit) return hit;
  const idx: Index = {
    hlrById: new Map(c.hlrs.map(h => [h.id, h])), llrById: new Map(c.llrs.map(l => [l.id, l])),
    fnById: new Map(c.fns.map(f => [f.id, f])), llrChildren: new Map(), testedLlrs: new Set(), callers: new Map(),
    resultByTest: new Map(c.results.map(r => [r.test, r])), covByFn: new Map(c.coverage.map(v => [v.fn, v])),
    couplingsByModule: new Map(), moduleByPrefix: new Map(), byModule: new Map(),
  };
  c.llrs.forEach(l => idx.llrChildren.set(l.hlr, (idx.llrChildren.get(l.hlr) ?? 0) + 1));
  c.tests.forEach(t => t.llrs.forEach(l => idx.testedLlrs.add(l)));
  c.fns.forEach(f => f.calls.forEach(k => idx.callers.set(k, (idx.callers.get(k) ?? 0) + 1)));
  c.design.forEach(d => { const s = idx.couplingsByModule.get(d.module) ?? new Set<string>(); d.couplings.forEach(x => s.add(x)); idx.couplingsByModule.set(d.module, s); });
  c.modules.forEach(m => {
    idx.moduleByPrefix.set(m.id.toLowerCase().replace(/-/g, '_'), m.id);
    idx.byModule.set(m.id, { module: m, hlrs: [], llrs: [], fns: [], tests: [], prs: [], cm: [], design: [] });
  });
  const put = <K extends keyof ModuleSlice>(mod: string, k: K, v: ModuleSlice[K] extends (infer U)[] ? U : never) => (idx.byModule.get(mod)![k] as unknown[]).push(v);
  c.hlrs.forEach(x => put(x.module, 'hlrs', x)); c.llrs.forEach(x => put(x.module, 'llrs', x)); c.fns.forEach(x => put(x.module, 'fns', x));
  c.tests.forEach(x => put(x.module, 'tests', x)); c.prs.forEach(x => put(x.module, 'prs', x)); c.cm.forEach(x => put(x.module, 'cm', x));
  c.design.forEach(x => put(x.module, 'design', x));
  cache.set(c, idx);
  return idx;
}

export const OWNER: Record<AgentName, string> = {
  Requirements: 'Requirements lead', Design: 'Design lead', Code: 'Code owner', Testing: 'Test lead', ConfigMgmt: 'CM lead',
};
let seq = 0;
export function resetFindingIds() { seq = 0; }
export function mk(layer: 'L1' | 'L2', agent: AgentName, kind: DefectKind | 'OTHER', severity: Severity, objective: string,
  title: string, detail: string, module: string, ref: string, citations: Citation[], rule: string): Finding {
  seq += 1;
  return { id: `${layer}-${agent.slice(0, 3).toUpperCase()}-${String(seq).padStart(5, '0')}`, layer, agent, rule, kind, severity,
    objective, title, detail, module, ref, citations, status: 'confirmed', owner: OWNER[agent] };
}
export const cite = {
  hlr: (id: string, text?: string): Citation => ({ kind: 'requirement', id, path: `reqs/HLR.reqif#${id}`, quote: text }),
  llr: (id: string, text?: string): Citation => ({ kind: 'requirement', id, path: `reqs/LLR.reqif#${id}`, quote: text }),
  fn: (f: Corpus['fns'][number], quote?: string): Citation => ({ kind: 'code', id: f.id, path: `${f.file}:L${f.start}-L${f.end}`, quote }),
  test: (id: string): Citation => ({ kind: 'test', id, path: `tests/${id}.xml` }),
  cov: (fn: string, m: string): Citation => ({ kind: 'coverage', id: fn, path: `coverage/${m.toLowerCase()}.json#${fn}` }),
  cm: (file: string, base: string): Citation => ({ kind: 'config', id: file, path: `cm/baseline_${base}.yaml#${file}` }),
  pr: (id: string): Citation => ({ kind: 'problem-report', id, path: `prs/${id}.json` }),
  des: (id: string): Citation => ({ kind: 'design', id, path: `design/${id}.md` }),
};

export function layer1(agent: AgentName, c: Corpus, idx: Index, moduleId: string): Finding[] {
  const s = idx.byModule.get(moduleId); if (!s) return [];
  const m = s.module, out: Finding[] = [];
  if (agent === 'Requirements') {
    s.hlrs.forEach(h => { if (!idx.llrChildren.get(h.id)) out.push(mk('L1', agent, 'HLR_NO_LLR', 2, 'A-3', `${h.id} has no low-level requirements`,
      'Every high-level requirement must be refined into at least one LLR before design and test can trace to it.', m.id, h.id, [cite.hlr(h.id, h.text)], 'R1 hlr-has-children')); });
    s.llrs.forEach(l => { if (!idx.hlrById.has(l.hlr)) out.push(mk('L1', agent, 'LLR_ORPHAN', 2, 'A-4', `${l.id} traces to ${l.hlr}, which does not exist`,
      'An LLR whose parent is missing breaks upward traceability.', m.id, l.id, [cite.llr(l.id, l.text)], 'R2 llr-has-parent')); });
  }
  if (agent === 'Design') {
    const allowed = idx.couplingsByModule.get(m.id) ?? new Set<string>();
    const doc = s.design.find(d => d.couplings.length) ?? s.design[0];
    s.fns.forEach(f => f.calls.forEach(call => {
      const callee = idx.fnById.get(call);
      const mt = call.match(/^(.*)_get_status$/);
      const target = callee ? callee.module : mt ? idx.moduleByPrefix.get(mt[1]) : undefined;
      if (!target || target === m.id || allowed.has(target)) return;
      out.push(mk('L1', agent, 'COUPLING_UNDOC', 2, 'A-4', `${f.id} calls into ${target}; coupling not in the design`,
        `Data and control coupling to ${target} must be described in the software architecture. Documented couplings: ${[...allowed].join(', ') || 'none'}.`,
        m.id, `${f.id}->${target}`, [cite.fn(f, `${call}(in, out);`), cite.des(doc.id)], 'D1 coupling-documented'));
    }));
  }
  if (agent === 'Code') {
    s.fns.forEach(f => {
      if (!f.llrs.length) out.push(mk('L1', agent, 'FN_NO_LLR', 2, 'A-5', `${f.id} traces to no requirement`,
        'Source code must trace to low-level requirements; untraced code is either missing a requirement or should not exist.', m.id, f.id, [cite.fn(f, '/* Implements: none */')], 'C1 fn-traces'));
      f.llrs.filter(l => !idx.llrById.has(l)).forEach(l => out.push(mk('L1', agent, 'FN_BAD_TAG', 3, 'A-5', `${f.id} cites ${l}, which does not exist`,
        'The trace tag in the source comment points at an unknown requirement ID.', m.id, f.id, [cite.fn(f, l)], 'C2 tag-resolves')));
      if (!f.entry && !idx.callers.get(f.id)) out.push(mk('L1', agent, 'DEAD_CODE', 3, 'A-5', `${f.id} is never called`,
        'No caller found anywhere in the program. Dead code must be removed or justified.', m.id, f.id, [cite.fn(f)], 'C3 no-dead-code'));
    });
  }
  if (agent === 'Testing') {
    s.llrs.forEach(l => { if (!idx.testedLlrs.has(l.id)) out.push(mk('L1', agent, 'LLR_NO_TEST', 2, 'A-7', `${l.id} has no test case`,
      'Requirements-based testing needs at least one test per LLR.', m.id, l.id, [cite.llr(l.id, l.text)], 'T1 llr-tested')); });
    s.tests.forEach(t => {
      const r = idx.resultByTest.get(t.id);
      if (!r) out.push(mk('L1', agent, 'TEST_NO_RESULT', 2, 'A-7', `${t.id} has no recorded result on baseline ${c.baseline}`,
        'A test case without a result is not verification evidence.', m.id, t.id, [cite.test(t.id)], 'T2 result-present'));
      else if (r.status === 'FAIL') out.push(mk('L1', agent, 'TEST_FAIL', m.dal === 'A' || m.dal === 'B' ? 1 : 2, 'A-7', `${t.id} fails on baseline ${c.baseline}`,
        `Failing test for ${t.llrs.join(', ')}. Run ${r.run}.`, m.id, t.id, [cite.test(t.id), cite.llr(t.llrs[0])], 'T3 test-passes'));
    });
    s.fns.forEach(f => {
      const v = idx.covByFn.get(f.id); if (!v) return;
      const need = m.dal === 'A' ? ['mcdc', v.mcdc, 'MC/DC'] : m.dal === 'B' ? ['dec', v.dec, 'decision'] : m.dal === 'C' ? ['stmt', v.stmt, 'statement'] : null;
      if (need && (need[1] as number) < 100) out.push(mk('L1', agent, 'COVERAGE_GAP', m.dal === 'A' ? 1 : 2, 'A-7', `${f.id} at ${need[1]}% ${need[2]} coverage; DAL ${m.dal} needs 100%`,
        'Structural coverage below the level the DAL requires.', m.id, f.id, [cite.cov(f.id, m.id), cite.fn(f)], 'T4 coverage-meets-dal'));
    });
  }
  if (agent === 'ConfigMgmt') {
    s.cm.forEach(r => { if (r.actualSha !== r.baselineSha) out.push(mk('L1', agent, 'CHECKSUM_MISMATCH', 1, 'A-8', `${r.file} does not match baseline ${c.baseline}`,
      `Recorded ${r.baselineSha.slice(0, 8)}…, found ${r.actualSha.slice(0, 8)}…. Evidence produced on this file may not apply to the baseline.`, m.id, r.file, [cite.cm(r.file, c.baseline)], 'M1 checksum-matches')); });
    s.prs.forEach(p => { if (p.status === 'OPEN') out.push(mk('L1', agent, 'OPEN_PR', p.sev, 'A-8', `${p.id} (severity ${p.sev}) is open: ${p.title.split(': ')[1] ?? p.title}`,
      `Open problem report against ${p.files.join(', ')} in the current baseline.`, m.id, p.id, [cite.pr(p.id)], 'M2 no-open-prs')); });
  }
  return out;
}
