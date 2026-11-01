// Layer 2: semantic review. Reads requirement text and code the way an engineer would.
// Uses an LLM when one is configured, and a rule-based reader otherwise, so the demo never depends on Wi-Fi.
// Every Layer 2 claim is then cross-checked against the source before it can count.
import type { Corpus, Finding, LLMClient, Citation } from './types';
import { type Index, mk, cite } from './layer1';

const VAGUE = /\b(should|TBD|as appropriate|quickly|where practical|in a timely manner)\b/i;
const THRESH_REQ = /after (\d+) consecutive frames/;

export interface L2Result { findings: Finding[]; disputes: { findingId: string; reason: string; quote: string }[]; llmCalls: number }

function parseArray(text: string): Record<string, unknown>[] {
  const m = text.match(/\[[\s\S]*\]/); if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : []; } catch { return []; }
}

export async function l2Requirements(c: Corpus, idx: Index, moduleId: string, llm: LLMClient | null): Promise<L2Result> {
  const s = idx.byModule.get(moduleId)!; const out: Finding[] = [];
  if (llm) {
    const list = s.llrs.map(l => `${l.id} | ${l.text}`).join('\n');
    const reply = await llm.complete(
      'You review avionics low-level requirements for DO-178C. A requirement is unverifiable if it uses "should" instead of "shall", contains TBD, or uses vague words such as "quickly", "as appropriate", "where practical", "in a timely manner". Reply with only a JSON array.',
      `Find every unverifiable requirement below. For each, return {"id": "...", "quote": "<the exact offending words copied from the text>", "reason": "<one short sentence>"}.\n\n${list}`);
    parseArray(reply).forEach(r => {
      const id = String(r.id ?? ''), quote = String(r.quote ?? ''), l = idx.llrById.get(id);
      out.push(mk('L2', 'Requirements', 'REQ_AMBIGUOUS', 3, 'A-4', `${id || 'Unknown requirement'} is not verifiable as written`,
        String(r.reason ?? 'Wording cannot be tested.'), moduleId, id, id ? [cite.llr(id, quote)] : [], 'S1 verifiable-wording'));
    });
    return { findings: out, disputes: [], llmCalls: 1 };
  }
  s.llrs.forEach(l => {
    const m = l.text.match(VAGUE); if (!m) return;
    const why = /should/i.test(m[0]) ? 'Uses "should", so the behavior is optional and cannot fail a test.' : /TBD/.test(m[0]) ? 'Contains TBD, so there is no value to test against.' : `"${m[0]}" has no measurable pass/fail criterion.`;
    out.push(mk('L2', 'Requirements', 'REQ_AMBIGUOUS', 3, 'A-4', `${l.id} is not verifiable as written`, why, moduleId, l.id, [cite.llr(l.id, m[0])], 'S1 verifiable-wording'));
  });
  return { findings: out, disputes: [], llmCalls: 0 };
}

export async function l2Code(c: Corpus, idx: Index, moduleId: string, l1DeadCode: Finding[], llm: LLMClient | null): Promise<L2Result> {
  const s = idx.byModule.get(moduleId)!; const out: Finding[] = []; const disputes: L2Result['disputes'] = []; let calls = 0;
  const pairs = s.llrs.filter(l => THRESH_REQ.test(l.text)).map(l => {
    const f = s.fns.find(x => x.llrs.includes(l.id));
    const line = f?.code.split('\n').find(x => x.includes(`/* ${l.id} */`));
    return f && line ? { l, f, line: line.trim() } : null;
  }).filter(Boolean) as { l: Corpus['llrs'][number]; f: Corpus['fns'][number]; line: string }[];

  if (llm && pairs.length) {
    calls++;
    const reply = await llm.complete(
      'You compare avionics requirements with the C code that implements them. Report only real contradictions. Reply with only a JSON array.',
      `For each pair, decide whether the code's numeric threshold contradicts the requirement. Return [{"llr":"...","fn":"...","req_quote":"<exact words from the requirement>","code_quote":"<exact code line>","reason":"..."}] for contradictions only.\n\n` +
      pairs.map(p => `${p.l.id}: ${p.l.text}\n${p.f.id}: ${p.line}`).join('\n\n'));
    parseArray(reply).forEach(r => {
      const l = idx.llrById.get(String(r.llr)), f = idx.fnById.get(String(r.fn));
      const cits: Citation[] = [cite.llr(l?.id ?? String(r.llr ?? ''), String(r.req_quote ?? '')), f ? cite.fn(f, String(r.code_quote ?? '')) : { kind: 'code', id: String(r.fn ?? ''), path: String(r.fn ?? '') }];
      out.push(mk('L2', 'Code', 'CODE_REQ_MISMATCH', 2, 'A-5', `${r.fn ?? 'Code'} contradicts ${r.llr ?? 'its requirement'}`,
        String(r.reason ?? 'Threshold in code differs from the requirement.'), moduleId, String(r.llr ?? ''), cits, 'S2 code-matches-requirement'));
    });
  } else {
    pairs.forEach(({ l, f, line }) => {
      const req = Number(l.text.match(THRESH_REQ)![1]); const code = Number((line.match(/>=\s*(\d+)/) ?? [])[1]);
      if (code && code !== req) out.push(mk('L2', 'Code', 'CODE_REQ_MISMATCH', 2, 'A-5', `${f.id} uses ${code} frames; ${l.id} says ${req}`,
        `The requirement trips after ${req} consecutive bad frames, the code after ${code}. One of them is wrong.`, moduleId, l.id,
        [cite.llr(l.id, `after ${req} consecutive frames`), cite.fn(f, line)], 'S2 code-matches-requirement'));
    });
  }

  // Second opinion on Layer 1 dead-code findings
  const cands = l1DeadCode.map(d => ({ d, f: idx.fnById.get(d.ref)! })).filter(x => x.f);
  if (llm && cands.length) {
    calls++;
    const reply = await llm.complete(
      'You check whether C functions flagged as never-called are truly dead code. Interrupt handlers and functions registered in vector tables are reached by hardware, not by C calls. Reply with only a JSON array.',
      `Return [{"fn":"...","dead":true|false,"quote":"<exact code that proves it>","reason":"..."}].\n\n` + cands.map(x => `--- ${x.f.id}\n${x.f.code}`).join('\n'));
    parseArray(reply).forEach(r => {
      if (r.dead === false) { const x = cands.find(k => k.f.id === r.fn); if (x) disputes.push({ findingId: x.d.id, reason: String(r.reason ?? 'Reached by hardware.'), quote: String(r.quote ?? '') }); }
    });
  } else {
    cands.forEach(({ d, f }) => {
      const hit = f.code.split('\n').find(x => x.includes('__attribute__((interrupt))'));
      if (hit) disputes.push({ findingId: d.id, quote: hit.trim(), reason: 'Registered in the interrupt vector table, so hardware calls it. Layer 1 cannot see that. Close with a justification instead of deleting it.' });
    });
  }
  return { findings: out, disputes, llmCalls: calls };
}

// Cross-check: a Layer 2 claim only counts if every citation exists and the quoted words are really there.
export function crossCheck(f: Finding, c: Corpus, idx: Index): { ok: boolean; reason?: string } {
  if (!f.citations.length) return { ok: false, reason: 'No citation, so the claim cannot be checked.' };
  for (const ct of f.citations) {
    let text: string | undefined;
    if (ct.kind === 'requirement') text = idx.llrById.get(ct.id)?.text ?? idx.hlrById.get(ct.id)?.text;
    else if (ct.kind === 'code') text = idx.fnById.get(ct.id)?.code;
    else text = '';
    if (text === undefined) return { ok: false, reason: `Cited ${ct.id} does not exist in baseline ${c.baseline}.` };
    if (ct.quote && text && !text.includes(ct.quote)) return { ok: false, reason: `Quoted words "${ct.quote}" are not in ${ct.id}.` };
  }
  return { ok: true };
}
