// The published A2A protocol must match what the broker actually enforces, and real traffic must conform to it.
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020';
import { ENVELOPE_SCHEMA, PAYLOAD_SCHEMAS, SENDER_TYPES, checkConformance, verifyTrail, protocolSpec, PROTOCOL_VERSION } from '../lib/engine/protocol';
import { Broker, validate } from '../lib/engine/broker';
import { runAudit, generateCorpus } from '../lib/engine';
import type { A2AMessage, MsgType } from '../lib/engine/types';

export function schemaChecker() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const s of Object.values(PAYLOAD_SCHEMAS)) ajv.addSchema(s);
  const v = ajv.compile(ENVELOPE_SCHEMA);
  return (m: unknown) => (v(m) ? null : ajv.errorsText(v.errors));
}

(async () => {
  const check = schemaChecker();
  const env = (from: string, type: MsgType, payload: Record<string, unknown>) => ({
    id: 'msg_000001', ts: 1, from, to: 'Orchestrator', subject: `audit.run_t.${from.toLowerCase()}.${type}`, type, correlationId: 'c1', payload, sig: 'a'.repeat(64) });

  // 1. Parity: for every message type, valid and invalid payloads get the same answer from the schema and the broker.
  const vectors: [string, MsgType, Record<string, unknown>][] = [
    ['Orchestrator', 'request', { scope: 'BARO-IN' }], ['Orchestrator', 'request', {}], ['Orchestrator', 'request', { scope: '' }],
    ['Testing', 'status', { text: 'running' }], ['Testing', 'status', {}],
    ['Code', 'error', { text: 'boom' }], ['Code', 'error', { text: '' }],
    ['Design', 'finding', { title: 'x', severity: 1, citations: ['design/d.csv#1'] }], ['Design', 'finding', { title: 'x', severity: 1, citations: [] }],
    ['Design', 'finding', { title: 'x', severity: 4, citations: ['a'] }], ['Design', 'finding', { severity: 2, citations: ['a'] }],
    ['Testing', 'dependency', { needs: 'LLRs', on: 'Requirements' }], ['Testing', 'dependency', { needs: 'LLRs' }],
    ['ConfigMgmt', 'blocker', { ref: 'src/a.c', impact: 'tests invalid' }], ['ConfigMgmt', 'blocker', { ref: 'src/a.c' }],
    ['Requirements', 'heartbeat', {}], ['Requirements', 'result', { count: 3 }], ['Requirements', 'result', { count: 'three' }],
  ];
  for (const [from, type, payload] of vectors) {
    const m = env(from, type, payload);
    assert.equal(check(m) === null, validate(m as never) === null, `${from} ${type} ${JSON.stringify(payload)}: schema says ${check(m)}, broker says ${validate(m as never)}`);
  }
  // Sender permissions: the published table matches the broker.
  for (const from of Object.keys(SENDER_TYPES)) for (const type of Object.keys(PAYLOAD_SCHEMAS) as MsgType[]) {
    const ok = validate({ from, to: 'Orchestrator', type, payload: { scope: 's', text: 't', title: 't', severity: 1, citations: ['c'], needs: 'n', on: 'Code', ref: 'r', impact: 'i', count: 1 } } as never);
    assert.equal(SENDER_TYPES[from].includes(type), !ok || !/not allowed/.test(ok), `${from} may send ${type}?`);
  }
  console.log(`parity: ${vectors.length} payload vectors and ${Object.keys(SENDER_TYPES).length * 8} sender/type pairs agree with the broker`);

  // 2. Real traffic: every accepted message from a full audit conforms to the published schema.
  const c = generateCorpus({ seed: 178 });
  const clean = await runAudit(c, { module: 'BARO-IN', layer2: 'heuristic' });
  for (const m of clean.messages.filter(x => x.accepted)) assert.equal(check(m), null, `${m.id} ${m.type}`);
  assert.ok(await verifyTrail(clean.messages));
  const bad = await runAudit(c, { module: 'BARO-IN', layer2: 'heuristic', faults: { Design: 'malformed' } });
  const rejected = bad.messages.filter(x => !x.accepted);
  assert.ok(rejected.length >= 2);
  console.log(`traffic: ${clean.messages.length} messages from a real audit conform; ${rejected.length} forged messages were rejected and kept`);

  // 3. Conformance: a well-behaved new agent passes; a buggy one gets specific reasons.
  const keys = { Orchestrator: 'k-orch', Requirements: 'k-req', Design: 'k-des', Code: 'k-code', Testing: 'k-new-testing-agent', ConfigMgmt: 'k-cm' };
  const good = new Broker('run_conf', keys);
  const send = (b: Broker, key: string, type: MsgType, payload: Record<string, unknown>, from: 'Testing' = 'Testing') => b.publish(from, key, { to: 'Orchestrator', type, payload, correlationId: 'corr' });
  await send(good, keys.Testing, 'heartbeat', { attempt: 1 });
  await send(good, keys.Testing, 'status', { text: 'Layer 1: checking 40 tests' });
  await send(good, keys.Testing, 'finding', { id: 'L1-TES-1', title: 'TC-1 fails', severity: 1, citations: ['tests/results.xml#TC-1'] });
  await send(good, keys.Testing, 'result', { count: 1 });
  const pass = await checkConformance(good.messages, 'Testing', keys.Testing, check);
  assert.ok(pass.ok, JSON.stringify(pass.problems));
  const buggy = new Broker('run_conf2', keys);
  await send(buggy, keys.Testing, 'finding', { title: 'unsourced', severity: 2, citations: [] });
  await send(buggy, 'wrong-key', 'status', { text: 'hello' });
  await buggy.publish('Testing', keys.Testing, { to: 'Orchestrator', type: 'request', payload: { scope: 'X' }, correlationId: 'c' });
  const fail = await checkConformance(buggy.messages, 'Testing', keys.Testing, check);
  assert.equal(fail.ok, false);
  const text = fail.problems.map(p => p.problem).join(' | ');
  assert.match(text, /citations/); assert.match(text, /signature does not verify/); assert.match(text, /may not send "request"|schema/);
  console.log('conformance: good agent passes;', fail.problems.length, 'problems found in the buggy one');

  const spec = protocolSpec(); assert.equal(spec.version, PROTOCOL_VERSION); assert.equal(Object.keys(spec.payloads).length, 8);
  void (null as unknown as A2AMessage);
  console.log('protocol: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
