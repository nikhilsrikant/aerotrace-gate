// The audit assistant cites every sentence; repetitive manual audits are spotted and turned into schedules.
import assert from 'node:assert/strict';
import { MemRepo } from '../lib/core/memRepo';
import { Services } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { sha256, type LLMClient } from '../lib/engine';
import type { Answer } from '../lib/core/assistant';

const grounded = (a: Answer) => {
  for (const s of a.sentences) for (const i of s.cites) assert.ok(i >= 0 && i < a.citations.length, `citation ${i} out of range`);
  if (!a.abstained) assert.ok(a.sentences.filter(s => s.text.length > 30).every(s => s.cites.length > 0), 'every substantive sentence cites a source:\n' + a.sentences.filter(s => !s.cites.length).map(s => s.text).join('\n'));
};
const text = (a: Answer) => a.sentences.map(s => s.text).join(' ');

(async () => {
  let clock = new Date('2026-09-20T16:00:00Z');
  const repo = new MemRepo();
  let llm: LLMClient | null = null;
  const svc = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true, now: () => clock, llm: async () => llm });
  const { datasetId: ds } = await seed(repo, svc, { demoUsers: true, syntheticDataset: true, hash: p => sha256(p) });
  const who = async (id: string) => svc.actorFor((await repo.getUser(id))!);
  const [marcus, priya, sam, jordan] = await Promise.all(['usr_marcus', 'usr_priya', 'usr_sam', 'usr_lee'].map(who));

  // Repetitive manual audits: FUEL-MON every morning around 09:00 Phoenix time, ALT-ALERT at random.
  const at = async (iso: string, mods: string[]) => { clock = new Date(iso); return svc.startAudits(marcus, { datasetId: ds!, modules: mods, layer2: 'heuristic' }); };
  await at('2026-09-20T16:02:00Z', ['FUEL-MON', 'BARO-IN']);
  await at('2026-09-21T15:55:00Z', ['FUEL-MON']);
  await at('2026-09-22T16:10:00Z', ['FUEL-MON', 'ALT-ALERT']);
  await at('2026-09-23T16:05:00Z', ['FUEL-MON']);
  await at('2026-09-24T03:00:00Z', ['ALT-ALERT']);
  await at('2026-09-28T21:00:00Z', ['ALT-ALERT']);
  const [baro2] = await at('2026-09-30T16:00:00Z', ['BARO-IN']);
  clock = new Date('2026-10-01T12:00:00Z');

  const sug = await svc.automationSuggestions(sam, 'America/Phoenix');
  console.log('suggestions:', sug.map(s => `${s.module}: ${s.description} -> ${JSON.stringify(s.recurrence)}`));
  assert.equal(sug.length, 1); assert.equal(sug[0].module, 'FUEL-MON');
  assert.deepEqual(sug[0].recurrence, { kind: 'daily', time: '09:00' });
  const sch = await svc.saveSchedule(sam, { name: 'FUEL-MON daily', datasetId: ds!, modules: ['FUEL-MON'], recurrence: sug[0].recurrence, timezone: 'America/Phoenix' });
  assert.equal(sch.nextRunAt, '2026-10-01T16:00:00.000Z');
  assert.equal((await svc.automationSuggestions(sam, 'America/Phoenix')).length, 0, 'gone once a schedule covers it');
  console.log('accepted suggestion -> schedule', sch.name, 'next', sch.nextRunAt);

  // The assistant
  let a = await svc.ask(priya, 'Why is BARO-IN not ready?', { timezone: 'America/Phoenix' }); grounded(a);
  assert.match(text(a), /BARO-IN \(DAL A\) is NO/); assert.ok(a.citations.some(c => c.kind === 'finding'));
  console.log('Q why BARO-IN ->', a.sentences.slice(0, 2).map(s => s.text + ' ' + s.cites.map(i => `[${i + 1}]`).join('')).join(' | '));
  a = await svc.ask(priya, 'what is waiting on me?'); grounded(a); assert.match(text(a), /waiting on you/);
  a = await svc.ask(marcus, 'Who can approve BARO-IN?'); grounded(a); assert.match(text(a), /Priya Raman/); assert.ok(a.citations.some(c => c.kind === 'policy'));
  a = await svc.ask(priya, 'which tests fail in baro-in'); grounded(a); assert.ok(a.citations.filter(c => c.kind === 'finding').length >= 1); assert.match(text(a), /failing test/);
  a = await svc.ask(priya, 'what changed since the last audit of BARO-IN?'); grounded(a); assert.match(text(a), /Since the previous audit/);
  a = await svc.ask(priya, "show me coverage gaps", { runId: baro2 }); grounded(a); assert.match(text(a), /coverage/);
  a = await svc.ask(priya, 'what is blocking ALT-ALERT?'); grounded(a); assert.match(text(a), /What holds ALT-ALERT/);
  a = await svc.ask(priya, 'which modules are not ready?'); grounded(a); assert.match(text(a), /Not ready:/);
  a = await svc.ask(priya, 'Automate ALT-ALERT every 24 hours'); grounded(a); assert.equal(a.proposal?.modules[0], 'ALT-ALERT'); assert.deepEqual(a.proposal?.recurrence, { kind: 'interval', everyMinutes: 1440 });
  a = await svc.ask(priya, 'schedule BARO-IN daily at 6am'); assert.deepEqual(a.proposal?.recurrence, { kind: 'daily', time: '06:00' });
  const fid = (await svc.getRun(priya, baro2)).result!.findings[0].id;
  a = await svc.ask(priya, `explain ${fid}`); grounded(a); assert.ok(a.citations.some(c => c.kind === 'finding' && c.findingId === fid));
  a = await svc.ask(priya, 'what is the weather in Tempe?'); assert.equal(a.abstained, true);
  console.log('abstains on off-topic:', text(a));
  // Viewers only see what they are allowed to: Jordan has audit.view, so fine; a user with nothing sees nothing.
  await repo.createUser({ id: 'usr_none', email: 'n@x.y', name: 'No Roles', active: true, provider: 'local', roleIds: [], groupIds: [], createdAt: clock.toISOString() });
  a = await svc.ask(await who('usr_none'), 'Why is BARO-IN not ready?'); assert.ok(!a.citations.length, 'no access, no sources'); void jordan;

  // LLM mode: good citations kept, out-of-range or invented IDs dropped.
  llm = { available: true, complete: async () => JSON.stringify({ sentences: [
    { text: 'BARO-IN is not ready because severity-1 findings are open.', cites: [1, 2] },
    { text: 'It also depends on PR-ZZZ-999, which is open.', cites: [2] },
    { text: 'This sentence cites a source that does not exist.', cites: [99] },
    { text: 'No citation at all.', cites: [] }] }) };
  a = await svc.ask(priya, 'Why is BARO-IN not ready?'); grounded(a);
  assert.equal(a.mode, 'llm'); assert.equal(a.sentences.length, 1, 'only the grounded sentence survives');
  console.log('LLM mode kept:', a.sentences.map(s => s.text));
  const log = await repo.allAudit(); assert.ok(log.some(e => e.action === 'assistant.asked'));
  console.log('assistant: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
