// aerotrace <command>: one entry point for the container.
//   web        start the web app (Next.js standalone server)        [handled by docker/entrypoint.sh]
//   worker     start a worker (jobs + scheduler + metrics)
//   migrate    apply schema migrations and first-run setup
//   create-admin --email a@b --name "A B" [--password ...]
//   reset-password --email a@b --password ...
//   reset-passkeys --email a@b             break-glass: clear someone's passkeys (e.g. the only admin lost theirs)
//   export-sample <file.zip> [--full]      write an evidence bundle that shows the format
//   verify-audit-log                       check the hash chain of the whole audit log
//   a2a-conformance <messages.json> --agent Testing --key <hmac key>   check a new agent's messages against the protocol
import { writeFileSync } from 'node:fs';
import { ctx } from './context';
import { PgRepo } from './pgRepo';
import { seed, ids } from '../core/seed';
import { hasher } from './crypto';
import { exportBundle } from '../core/bundle';
import { generateCorpus, randomId } from '../engine';
import { verifyAuditChain } from '../core/auditHash';
import { startWorker } from './worker';
import { checkPassword } from '../core/services';
import { prepareProcess } from './prepare';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const say = (m: string) => process.stdout.write(m + '\n');

async function main() {
  const cmd = process.argv[2];
  // Secret references (NAME_REF) and telemetry before anything reads configuration.
  if (cmd && cmd !== 'export-sample' && cmd !== 'a2a-conformance') await prepareProcess(cmd === 'worker' ? 'worker' : 'cli', cmd === 'migrate' || cmd === 'worker' ? ['DATABASE_URL'] : []);
  if (cmd === 'worker') return startWorker();
  if (cmd === 'export-sample') {
    const out = process.argv[3] || 'sample-bundle.zip';
    const c = generateCorpus(process.argv.includes('--full') ? {} : { total: 0 });
    const small = process.argv.includes('--full') ? c : shrink(c, 3);
    writeFileSync(out, await exportBundle(small)); say(`wrote ${out} (${small.total} records, ${small.modules.length} modules)`); return;
  }
  if (cmd === 'a2a-conformance') {
    const { readFileSync } = await import('node:fs');
    const { default: Ajv2020 } = await import('ajv/dist/2020');
    const { ENVELOPE_SCHEMA, PAYLOAD_SCHEMAS, checkConformance, PROTOCOL_VERSION } = await import('../engine/protocol');
    const file = process.argv[3]; const agent = arg('agent'); const key = arg('key');
    if (!file || !agent || !key) throw new Error('usage: a2a-conformance <messages.json> --agent <name> --key <hmac key>');
    const ajv = new Ajv2020({ allErrors: true, strict: false }); for (const s of Object.values(PAYLOAD_SCHEMAS)) ajv.addSchema(s); const v = ajv.compile(ENVELOPE_SCHEMA);
    const msgs = JSON.parse(readFileSync(file, 'utf8'));
    // Accepts a plain array, { messages }, or an evidence package (only this agent's messages are checked).
    const list = (Array.isArray(msgs) ? msgs : msgs.messages ?? msgs.run?.result?.messages ?? []).filter((m: { from?: string }) => !msgs.run || m.from === agent);
    const r = await checkConformance(list, agent, key, m => (v(m) ? null : ajv.errorsText(v.errors)));
    say(`A2A v${PROTOCOL_VERSION} conformance for ${agent}: ${r.checked} messages, ${r.problems.length} problems`);
    for (const p of r.problems) say(`  #${p.index}${p.id ? ` ${p.id}` : ''}: ${p.problem}`);
    say(r.ok ? 'PASS: this agent can join the broker.' : 'FAIL: fix the problems above before registering this agent.'); process.exitCode = r.ok ? 0 : 1; return;
  }
  if (cmd === 'migrate') { const pre = PgRepo.fromEnv(); try { await pre.migrate(say); } finally { await pre.pool.end(); } }
  const { repo, svc } = await ctx();
  try {
    if (cmd === 'migrate') {
      const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
      if (password) checkPassword(password);
      const r = await seed(repo, svc, { admin: email ? { email, name: process.env.ADMIN_NAME || 'Administrator', password: password || null } : undefined,
        demoUsers: process.env.SEED_DEMO_USERS === 'true', syntheticDataset: process.env.SEED_DEMO_DATA !== 'false', hash: hasher.hash });
      say(r.created ? `first-run setup done${email ? `; administrator ${email}` : '; no ADMIN_EMAIL set, create one with create-admin'}` : 'schema up to date');
      return;
    }
    if (cmd === 'create-admin') {
      const email = arg('email'), name = arg('name') || 'Administrator', password = arg('password');
      if (!email) throw new Error('--email is required');
      if (password) checkPassword(password);
      const existing = await repo.getUserByEmail(email);
      if (existing) { await repo.updateUser(existing.id, { roleIds: [...new Set([...existing.roleIds, ids.roleAdmin])], active: true, allowPasswordEnrollment: true }); say(`granted Administrator to ${email}`); }
      else { await repo.createUser({ id: randomId('usr'), email: email.toLowerCase(), name, active: true, provider: password ? 'local' : 'oidc', passwordHash: password ? await hasher.hash(password) : null, roleIds: [ids.roleAdmin], groupIds: [], createdAt: new Date().toISOString(), mustChangePassword: !!password, allowPasswordEnrollment: true }); say(`created administrator ${email}`); }
      await repo.appendAudit({ actorId: 'cli', actorName: 'CLI', action: 'user.admin_granted', target: email.toLowerCase(), details: {} });
      return;
    }
    if (cmd === 'reset-password') {
      const email = arg('email'), password = arg('password'); if (!email || !password) throw new Error('--email and --password are required');
      checkPassword(password);
      const u = await repo.getUserByEmail(email); if (!u) throw new Error(`no user ${email}`);
      await repo.updateUser(u.id, { passwordHash: await hasher.hash(password), mustChangePassword: true, provider: 'local' }); await repo.deleteUserSessions(u.id);
      await repo.appendAudit({ actorId: 'cli', actorName: 'CLI', action: 'user.password_reset', target: u.id, details: {} });
      say(`password reset for ${email}; they must change it at next sign-in`); return;
    }
    if (cmd === 'reset-passkeys') {
      const email = arg('email'); if (!email) throw new Error('--email is required');
      const u = await repo.getUserByEmail(email); if (!u) throw new Error(`no user ${email}`);
      const keys = await repo.listPasskeys(u.id); for (const k of keys) await repo.deletePasskey(k.id);
      await repo.deleteUserSessions(u.id); await repo.updateUser(u.id, { allowPasswordEnrollment: true });
      await repo.appendAudit({ actorId: 'cli', actorName: 'CLI', action: 'passkey.reset', target: u.id, details: { removed: keys.length, user: u.email, via: 'break-glass CLI' } });
      say(`removed ${keys.length} passkey(s) for ${email}; they set up a new one at next sign-in`); return;
    }
    if (cmd === 'verify-audit-log') { const v = await verifyAuditChain(await repo.allAudit()); say(v.ok ? `audit log intact: ${v.checked} events` : `AUDIT LOG BROKEN at event ${v.brokenAt}: ${v.reason}`); process.exitCode = v.ok ? 0 : 2; return; }
    say('usage: aerotrace web | worker | migrate | create-admin | reset-password | reset-passkeys | export-sample | verify-audit-log'); process.exitCode = 1;
  } finally { if (cmd !== 'worker') await repo.pool.end(); }
}

function shrink(c: ReturnType<typeof generateCorpus>, n: number) {
  const keep = new Set(c.modules.slice(0, n).map(m => m.id));
  const tests = c.tests.filter(t => keep.has(t.module)); const testIds = new Set(tests.map(t => t.id));
  const fns = c.fns.filter(f => keep.has(f.module)); const fnIds = new Set(fns.map(f => f.id));
  const out = { ...c, modules: c.modules.filter(m => keep.has(m.id)), hlrs: c.hlrs.filter(x => keep.has(x.module)), llrs: c.llrs.filter(x => keep.has(x.module)),
    design: c.design.filter(x => keep.has(x.module)), fns, tests, results: c.results.filter(r => testIds.has(r.test)), coverage: c.coverage.filter(v => fnIds.has(v.fn)),
    prs: c.prs.filter(x => keep.has(x.module)), cm: c.cm.filter(x => keep.has(x.module)), plans: c.plans.slice(0, 24), truth: c.truth.filter(t => keep.has(t.module)) };
  return { ...out, total: out.hlrs.length + out.llrs.length + out.design.length + out.fns.length + out.tests.length + out.results.length + out.coverage.length + out.prs.length + out.cm.length + out.plans.length };
}

main().catch(e => { process.stderr.write(`aerotrace: ${(e as Error).message}\n`); process.exit(1); });
