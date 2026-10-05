// Audit assistant: answers questions about audit results, and every sentence carries the sources it came from.
// Works offline with a rule-based reader; with an LLM configured, the model writes the answer but may only
// cite the numbered sources it was given, and any sentence whose citations don't check out is dropped.
import type { RunView, ApprovalView } from './services';
import type { RunRecord, Schedule, ApprovalPolicy } from './model';
import type { Finding, LLMClient, DefectKind } from '../engine/types';
import { AGENT_LABEL } from '../engine/types';

export type Citation =
  | { kind: 'run'; runId: string; label: string; detail: string }
  | { kind: 'finding'; runId: string; findingId: string; label: string; detail: string; evidence: string[] }
  | { kind: 'decision'; runId: string; label: string; detail: string }
  | { kind: 'policy'; policyId: string; label: string; detail: string }
  | { kind: 'schedule'; scheduleId: string; label: string; detail: string };
export interface Sentence { text: string; cites: number[] }
export interface AutomationProposal { datasetId: string; datasetName: string; modules: string[]; recurrence: Schedule['recurrence']; timezone: string; name: string; why: string }
export interface Answer { sentences: Sentence[]; citations: Citation[]; mode: 'rules' | 'llm'; followUps: string[]; proposal?: AutomationProposal; abstained?: boolean }

type FullRun = RunView & Pick<RunRecord, 'result'>;
export interface AssistantData {
  me: { id: string; name: string };
  runs: () => Promise<RunView[]>;                 // what this person may see, newest first
  run: (id: string) => Promise<FullRun>;
  diff: (id: string) => Promise<{ previous: { id: string; createdAt: string; verdict?: string | null } | null; added: { severity: number; title: string }[]; resolved: { severity: number; title: string }[]; unchanged: number } | null>;
  schedules: () => Promise<Schedule[]>;
  policies: () => Promise<ApprovalPolicy[]>;
  inbox: () => Promise<{ mine: RunView[] }>;
  describe: (s: Schedule) => string;
  timezone: string;
}

const KIND_WORDS: [RegExp, DefectKind[], string][] = [
  [/\b(fail(ing|ed|s)?\s+tests?|tests?\s+(that\s+)?fail)/, ['TEST_FAIL'], 'failing tests'],
  [/\b(no|missing)\s+(test\s+)?results?|not\s+run/, ['TEST_NO_RESULT'], 'tests with no recorded result'],
  [/\bcoverage|mc\/?dc|structural/, ['COVERAGE_GAP'], 'coverage gaps'],
  [/\bchecksum|baseline\s+mismatch|re-?baseline|configuration|\bcm\b/, ['CHECKSUM_MISMATCH'], 'baseline mismatches'],
  [/\bproblem\s+reports?|\bprs?\b|open\s+pr/, ['OPEN_PR'], 'open problem reports'],
  [/\bdead\s+code|never\s+called|unreachable/, ['DEAD_CODE'], 'dead code'],
  [/\buntraced|no\s+requirement|trace\s*tag|traceab/, ['FN_NO_LLR', 'FN_BAD_TAG', 'LLR_ORPHAN', 'HLR_NO_LLR'], 'traceability gaps'],
  [/\buntested|no\s+test\s+case|without\s+tests?/, ['LLR_NO_TEST'], 'requirements without tests'],
  [/\bcoupling|architecture|design\b/, ['COUPLING_UNDOC'], 'undocumented couplings'],
  [/\bambiguous|vague|should\b|tbd|verifiable/, ['REQ_AMBIGUOUS'], 'unverifiable requirements'],
  [/\bcontradict|threshold|mismatch(es)?\s+between|code\s+vs|doesn'?t\s+match/, ['CODE_REQ_MISMATCH'], 'code that contradicts its requirement'],
];
const STOP = new Set('the a an is are was were of for to in on and or what which who why how does do did any all me my i you this that it its with be there show tell list give about from at by can should audit audits module'.split(' '));

class Builder {
  sentences: Sentence[] = []; citations: Citation[] = []; followUps: string[] = []; proposal?: AutomationProposal;
  cite(c: Citation) { const k = JSON.stringify(c); const i = this.citations.findIndex(x => JSON.stringify(x) === k); if (i >= 0) return i; this.citations.push(c); return this.citations.length - 1; }
  say(text: string, ...cs: Citation[]) { this.sentences.push({ text, cites: cs.map(c => this.cite(c)) }); }
  done(mode: Answer['mode'] = 'rules'): Answer { return { sentences: this.sentences, citations: this.citations, mode, followUps: this.followUps.slice(0, 3), proposal: this.proposal, abstained: !this.sentences.some(s => s.cites.length) }; }
}
const runCite = (r: RunView): Citation => ({ kind: 'run', runId: r.id, label: `${r.module} audit ${new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, detail: `${r.datasetName} · verdict ${r.verdict ?? r.status} · report ${r.reportHash?.slice(0, 12) ?? 'pending'}` });
const findingCite = (r: RunView, f: Finding): Citation => ({ kind: 'finding', runId: r.id, findingId: f.id, label: `${r.module} · ${f.id}`, detail: `${AGENT_LABEL[f.agent]} · Table ${f.objective} · ${f.title}`, evidence: f.citations.map(c => c.path) });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

function matchModules(q: string, runs: RunView[]): string[] {
  const mods = [...new Map(runs.map(r => [r.module, r])).values()];
  const ql = ' ' + q.toLowerCase().replace(/[^a-z0-9\- ]/g, ' ') + ' ';
  const hits = mods.filter(r => {
    const id = r.module.toLowerCase();
    if (ql.includes(` ${id} `) || ql.includes(` ${id.replace(/-/g, ' ')} `) || ql.includes(` ${id.replace(/-/g, '')} `)) return true;
    const name = r.moduleName.toLowerCase();
    return name.length > 6 && ql.includes(` ${name} `);
  }).map(r => r.module);
  if (hits.length) return hits;
  const head = mods.filter(r => { const first = r.module.toLowerCase().split('-')[0]; return first.length >= 3 && new RegExp(`\\b${first}\\b`).test(ql); }).map(r => r.module);
  return head;
}
const latestFinished = (runs: RunView[], module: string) => runs.find(r => r.module === module && !!r.verdict);

export async function answerRules(question: string, d: AssistantData, ctxRunId?: string): Promise<Answer> {
  const q = question.toLowerCase().trim(); const b = new Builder();
  const runs = await d.runs();
  if (!q) { b.say('Ask about any audit you can see, for example "Why is BARO-IN not ready?" or "What is waiting on me?".'); return b.done(); }
  let mods = matchModules(q, runs);
  const ctxRun = ctxRunId ? runs.find(r => r.id === ctxRunId) : undefined;
  if (!mods.length && ctxRun) mods = [ctxRun.module];
  const findId = q.match(/\bl[12]-[a-z]{3}-\d{5}\b/i)?.[0]?.toUpperCase();

  // 1. my queue
  if (/(waiting on me|my (queue|inbox|approvals)|(do|should|must|need to) i (approve|sign|review)|what can i (approve|sign)|assigned to me)/.test(q)) {
    const ib = await d.inbox();
    if (!ib.mine.length) b.say('Nothing is waiting on you right now. Approval policies decide which steps you can sign, and none of the open audits are at one of them.');
    else { b.say(`${plural(ib.mine.length, 'audit')} ${ib.mine.length === 1 ? 'is' : 'are'} waiting on you.`, ...ib.mine.slice(0, 6).map(runCite));
      ib.mine.slice(0, 4).forEach(r => b.say(`${r.module} is ${r.verdict}; you would sign "${r.approval.myStep}"${r.approval.onBehalfOf ? ` on behalf of ${r.approval.onBehalfOf}` : ''}.`, runCite(r))); }
    b.followUps.push(ib.mine[0] ? `Why is ${ib.mine[0].module} ${ib.mine[0].verdict}?` : 'Which audits are not ready?');
    return b.done();
  }
  // 2. a specific finding
  if (findId) {
    for (const r of runs.filter(x => x.verdict).slice(0, 60)) {
      const full = await d.run(r.id); const f = full.result?.findings.find(x => x.id === findId);
      if (f) { b.say(`${f.id} is a ${f.layer === 'L1' ? 'Layer 1 rule' : 'Layer 2 semantic'} finding from the ${AGENT_LABEL[f.agent]} agent in the ${r.module} audit: ${f.title}.`, findingCite(r, f));
        b.say(f.detail, findingCite(r, f));
        if (f.dispute) b.say(`${f.status === 'disputed' ? 'Layer 2 disputes it' : 'The cross-check rejected it'}: ${f.dispute}`, findingCite(r, f));
        b.say(`Owner: ${f.owner}. Evidence: ${f.citations.map(c => c.path).join('; ')}.`, findingCite(r, f)); return b.done(); }
    }
    b.say(`I can't find ${findId} in the audits you can see.`); return b.done();
  }
  // 3. not-ready overview across modules
  if (!mods.length && /(not ready|which .*(no|fail|block)|worst|severity.?1|s1\b|overview|summary|status of all|everything)/.test(q)) {
    const latest = [...new Map(runs.filter(r => r.verdict).map(r => [r.module, r])).values()];
    const no = latest.filter(r => r.verdict === 'NO'), cond = latest.filter(r => r.verdict === 'CONDITIONAL'), yes = latest.filter(r => r.verdict === 'YES');
    b.say(`Across the latest audit of ${plural(latest.length, 'module')}: ${no.length} NO, ${cond.length} CONDITIONAL, ${yes.length} YES.`, ...latest.slice(0, 8).map(runCite));
    if (no.length) b.say(`Not ready: ${list(no.slice(0, 8).map(r => `${r.module} (${r.summary?.counts.s1 ?? 0} severity 1)`))}.`, ...no.slice(0, 8).map(runCite));
    if (no[0]) b.followUps.push(`What is blocking ${no[0].module}?`);
    return b.done();
  }
  // 4. schedules and automation
  if (/(schedul|automat|recurr|every (day|night|week|\d+ ?h)|nightly|daily|weekly|next run|run (it )?(by itself|regularly|automatically))/.test(q)) {
    const all = await d.schedules();
    const rel = mods.length ? all.filter(s => s.modules.some(p => mods.some(m => p === '*' || new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(m)))) : all;
    const wantsNew = /(automat|set up|create|make|add|start).*(schedul|daily|every|nightly|weekly|regular)|schedule (it|this|them)|run .* (every|daily|nightly)/.test(q);
    rel.slice(0, 5).forEach(s => b.say(`"${s.name}" (${d.describe(s).replace(/^./, c => c.toLowerCase())}) ${s.enabled ? 'covers' : 'would cover'} ${mods.length ? list(mods) : s.modules.join(', ')}${s.enabled ? `; next run ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'soon'}` : ', but it is paused'}.`,
      { kind: 'schedule', scheduleId: s.id, label: s.name, detail: d.describe(s) }));
    if (!rel.length) b.say(mods.length ? `No schedule covers ${list(mods)} yet.` : 'There are no schedules yet.', { kind: 'schedule', scheduleId: '', label: 'All schedules', detail: `${all.length} schedule${all.length === 1 ? '' : 's'} checked` });
    if (wantsNew || !rel.length) {
      const target = mods.length ? mods : ctxRun ? [ctxRun.module] : [];
      const ref = target.length ? latestFinished(runs, target[0]) ?? runs.find(r => r.module === target[0]) : runs[0];
      if (ref) {
        const rec = recurrenceFrom(q);
        const mlist = target.length ? target : [ref.module];
        b.proposal = { datasetId: ref.datasetId, datasetName: ref.datasetName, modules: mlist, recurrence: rec, timezone: d.timezone, name: `${mlist.join(', ')} · ${rec.kind === 'interval' ? (rec.everyMinutes === 1440 ? 'every 24 hours' : `every ${rec.everyMinutes / 60} h`) : rec.kind === 'daily' ? `daily ${rec.time}` : 'weekly'}`, why: 'Asked in the assistant' };
        b.say(`I can set up an automatic audit of ${list(mlist)} on ${ref.datasetName}, ${rec.kind === 'interval' ? (rec.everyMinutes === 1440 ? 'every 24 hours' : `every ${rec.everyMinutes / 60} hours`) : rec.kind === 'daily' ? `daily at ${rec.time}` : rec.kind === 'weekly' ? `every Monday at ${rec.time}` : ''}. Confirm below; the results will follow the usual approval policy.`, runCite(ref));
      }
    }
    return b.done();
  }
  if (!mods.length) {
    // fallback: keyword search over the latest findings
    const words = q.split(/\W+/).filter(w => w.length > 2 && !STOP.has(w));
    const latest = [...new Map(runs.filter(r => r.verdict).map(r => [r.module, r])).values()].slice(0, 40);
    const scored: { r: RunView; f: Finding; s: number }[] = [];
    for (const r of latest) { const full = await d.run(r.id); for (const f of full.result?.findings ?? []) { const t = `${f.title} ${f.detail} ${f.ref}`.toLowerCase(); const s = words.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0); if (s) scored.push({ r, f, s }); } }
    scored.sort((a, b2) => b2.s - a.s || a.f.severity - b2.f.severity);
    if (words.length && scored.length && scored[0].s >= Math.min(2, words.length)) {
      b.say(`The closest matches in the latest audits:`, ...scored.slice(0, 3).map(x => findingCite(x.r, x.f)));
      scored.slice(0, 3).forEach(x => b.say(`${x.r.module}: ${x.f.title}.`, findingCite(x.r, x.f)));
      return b.done();
    }
    const names = [...new Set(runs.map(r => r.module))].slice(0, 6);
    b.say(`I can't answer that from the audits you can see. Name a module (for example ${list(names.slice(0, 3))}) or ask what is waiting on you.`);
    b.followUps.push('What is waiting on me?', names[0] ? `Why is ${names[0]} not ready?` : 'Which audits are not ready?');
    return b.done();
  }

  // module-specific questions use the latest finished audit of each named module
  for (const m of mods.slice(0, 3)) {
    const r0 = latestFinished(runs, m);
    if (!r0) { const any = runs.find(r => r.module === m); b.say(any ? `The ${m} audit is still ${any.status.replace('_', ' ')}.` : `There is no audit of ${m} you can see yet.`, ...(any ? [runCite(any)] : [])); continue; }
    const r = await d.run(r0.id); const res = r.result!; const conf = res.findings.filter(f => f.status === 'confirmed');
    const a: ApprovalView = r.approval;
    const kinds = KIND_WORDS.filter(([re]) => re.test(q));
    if (/(who|which (people|group|person)).*(approv|sign|review|deny)|approver|sign.?off|who signs/.test(q)) {
      b.say(`${m} follows the "${a.policyName ?? 'no'}" policy${a.policyVersion ? ` (v${a.policyVersion})` : ''}. ${a.waitingOn}.`, runCite(r), ...(a.policyId ? [{ kind: 'policy', policyId: a.policyId, label: a.policyName!, detail: `v${a.policyVersion}` } as Citation] : []));
      a.steps.forEach(s => b.say(`Step "${s.name}" needs ${s.min}: ${s.approvals.length ? `signed by ${list(s.approvals.map(x => x.by + (x.onBehalfOf ? ` for ${x.onBehalfOf}` : '')))}` : s.open ? `can be signed by ${s.eligible.length ? list(s.eligible.map(e => e.name + (e.via === 'delegation' ? ' (delegate)' : ''))) : 'nobody right now'}` : 'opens after the step before it'}.`, ...(a.policyId ? [{ kind: 'policy', policyId: a.policyId, label: a.policyName!, detail: `v${a.policyVersion}` } as Citation] : [runCite(r)])));
      r.decisions.forEach(dc => b.say(`${dc.userName} ${dc.action === 'approve' ? 'approved' : 'denied'} "${dc.stepName}"${dc.onBehalfOf ? ` on behalf of ${dc.onBehalfOf.name}` : ''}${dc.reason ? ` with the reason "${dc.reason}"` : ''}.`, { kind: 'decision', runId: r.id, label: `${dc.userName} · ${dc.stepName}`, detail: `${dc.signature.alg} ${dc.signature.keyId} · ${new Date(dc.at).toLocaleString('en-US')}` }));
      continue;
    }
    if (/(chang|since (the )?last|new (finding|issue)|resolved|fixed|regress|compare|previous)/.test(q)) {
      const df = await d.diff(r.id);
      if (!df?.previous) b.say(`This is the first audit of ${m} on ${r.datasetName}, so there is nothing to compare with.`, runCite(r));
      else { const prevCite: Citation = { kind: 'run', runId: df.previous.id, label: `${m} audit ${new Date(df.previous.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, detail: `verdict ${df.previous.verdict}` };
        b.say(`Since the previous audit (${df.previous.verdict}), ${plural(df.added.length, 'finding')} ${df.added.length === 1 ? 'is' : 'are'} new, ${df.resolved.length} resolved and ${df.unchanged} unchanged.`, runCite(r), prevCite);
        df.added.slice(0, 3).forEach(x => b.say(`New: ${x.title}.`, runCite(r))); df.resolved.slice(0, 3).forEach(x => b.say(`Resolved: ${x.title}.`, prevCite)); }
      continue;
    }
    if (/(disput|layer ?2|semantic|rejected|cross.?check|llm)/.test(q)) {
      const l2 = res.findings.filter(f => f.layer === 'L2'), dis = res.findings.filter(f => f.status === 'disputed'), rej = res.findings.filter(f => f.status === 'rejected');
      b.say(`In ${m}, Layer 2 raised ${plural(l2.length, 'finding')} (${rej.length} rejected by the cross-check) and disputed ${plural(dis.length, 'Layer 1 finding')}.`, runCite(r));
      dis.slice(0, 3).forEach(f => b.say(`Disputed: ${f.title}. ${f.dispute}`, findingCite(r, f)));
      rej.slice(0, 2).forEach(f => b.say(`Rejected: ${f.title}. ${f.dispute}`, findingCite(r, f)));
      continue;
    }
    if (/(agent|offline|retr(y|ies)|breaker|health|latency|timeout|message|broker|trail)/.test(q)) {
      const off = res.health.filter(h => h.state === 'offline'), deg = res.health.filter(h => h.state === 'degraded');
      b.say(`The ${m} audit exchanged ${res.stats.messages} broker messages (${res.stats.rejectedMessages} rejected); the trail hash chain is ${res.chainValid ? 'intact' : 'broken'}.`, runCite(r));
      b.say(off.length || deg.length ? `${list([...off.map(h => `${AGENT_LABEL[h.agent]} was offline`), ...deg.map(h => `${AGENT_LABEL[h.agent]} recovered after ${plural(h.retries, 'retry')}`)])}.` : 'All five agents were healthy with no retries.', runCite(r));
      continue;
    }
    if (kinds.length) {
      for (const [, ks, label] of kinds.slice(0, 2)) {
        const fs = conf.filter(f => ks.includes(f.kind as DefectKind));
        if (!fs.length) { b.say(`The latest ${m} audit has no ${label}.`, runCite(r)); continue; }
        b.say(`The latest ${m} audit has ${plural(fs.length, label.replace(/s$/, ''))}${fs.length > 1 && !label.endsWith('s') ? '' : ''}.`, ...fs.slice(0, 5).map(f => findingCite(r, f)));
        fs.slice(0, 4).forEach(f => b.say(`${f.title} (severity ${f.severity}, owner ${f.owner}).`, findingCite(r, f)));
      }
      continue;
    }
    if (/(block|critical path|next (step|action)|fix|what (should|do) (we|i)|to do|action)/.test(q)) {
      b.say(`What holds ${m} at ${res.verdict}:`, runCite(r));
      res.criticalPath.forEach((s, i) => { const f = s.finding ? res.findings.find(x => x.id === s.finding) : undefined; b.say(`${i + 1}. ${AGENT_LABEL[s.agent]}: ${s.title}.`, ...(f ? [findingCite(r, f)] : [runCite(r)])); });
      res.nextActions.slice(0, 4).forEach(x => { const f = conf.find(y => (x.action && y.owner === x.owner && y.severity === x.severity)); b.say(`${x.onCriticalPath ? 'First' : 'Then'}: ${x.action} (${x.count}), owner ${x.owner}.`, ...(f ? [findingCite(r, f)] : [runCite(r)])); });
      continue;
    }
    if (/(how many|count|number of|severity)/.test(q)) {
      const s = res.stats.bySeverity;
      b.say(`The latest ${m} audit has ${s['1']} severity-1, ${s['2']} severity-2 and ${s['3']} severity-3 confirmed findings (${res.stats.l1} from Layer 1, ${res.stats.l2 - res.stats.rejected} from Layer 2).`, runCite(r));
      continue;
    }
    // default: verdict and why
    b.say(`${m} (DAL ${r.dal}) is ${res.verdict}: ${res.verdictReason}`, runCite(r));
    const top = [...conf].sort((x, y) => x.severity - y.severity).filter((f, i, arr) => arr.findIndex(g => g.kind === f.kind) === i).slice(0, 3);
    top.forEach(f => b.say(`${f.severity === 1 ? 'Blocking' : 'Open'}: ${f.title}.`, findingCite(r, f)));
    b.say(`Approval: ${a.waitingOn}.`, runCite(r));
    b.followUps.push(`What is blocking ${m}?`, `Who can approve ${m}?`, `Automate ${m} every 24 hours`);
  }
  return b.done();
}

/** LLM mode: the model writes the answer, but only from numbered sources, and every citation is checked. */
export async function answerLLM(question: string, d: AssistantData, llm: LLMClient, ctxRunId?: string): Promise<Answer> {
  const base = await answerRules(question, d, ctxRunId);
  if (base.proposal || !base.citations.length) return base;          // actions and "can't find it" stay deterministic
  const sources = base.citations.map((c, i) => `[${i + 1}] ${c.label}: ${c.detail}${'evidence' in c && c.evidence.length ? ` · evidence ${c.evidence.join('; ')}` : ''}`).join('\n');
  const facts = base.sentences.map(s => `- ${s.text} ${s.cites.map(i => `[${i + 1}]`).join('')}`).join('\n');
  const reply = await llm.complete(
    'You answer questions about DO-178C audit results for engineers. Use only the facts and sources given. Every sentence must end with one or more source numbers like [2]. If the facts do not answer the question, say so. Reply with JSON only: {"sentences":[{"text":"...","cites":[1,2]}]}',
    `Question: ${question}\n\nFacts:\n${facts}\n\nSources:\n${sources}`);
  try {
    const parsed = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { sentences?: { text: string; cites: number[] }[] };
    const ok = (parsed.sentences ?? []).filter(s => typeof s.text === 'string' && Array.isArray(s.cites) && s.cites.length && s.cites.every(n => Number.isInteger(n) && n >= 1 && n <= base.citations.length))
      .map(s => ({ text: s.text.replace(/\s*\[\d+\]/g, '').trim(), cites: [...new Set(s.cites.map(n => n - 1))] }));
    // a sentence that names IDs must find them in its own sources
    const grounded = ok.filter(s => { const ids = s.text.match(/\b(?:[A-Z]{2,}-[A-Z0-9]{2,}-\d{2,5}|L[12]-[A-Z]{3}-\d{5}|run_[a-f0-9]+)\b/g) ?? []; const src = s.cites.map(i => JSON.stringify(base.citations[i])).join(' '); return ids.every(id => src.includes(id) || base.sentences.some(b2 => b2.text.includes(id))); });
    if (!grounded.length) return base;
    return { ...base, sentences: grounded, mode: 'llm' };
  } catch { return base; }
}

function recurrenceFrom(q: string): Schedule['recurrence'] {
  const at = q.match(/\bat\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const time = at ? (() => { let h = Number(at[1]); if (at[3] === 'pm' && h < 12) h += 12; if (at[3] === 'am' && h === 12) h = 0; return `${String(Math.min(h, 23)).padStart(2, '0')}:${at[2] ?? '00'}`; })() : '02:00';
  if (/week/.test(q)) return { kind: 'weekly', days: [1], time };
  const hrs = q.match(/every\s*(\d+)\s*(h|hrs?|hours?)\b/);
  if (hrs) return { kind: 'interval', everyMinutes: Math.max(1, Number(hrs[1])) * 60 };
  if (at) return { kind: 'daily', time };
  return { kind: 'interval', everyMinutes: 1440 };
}
