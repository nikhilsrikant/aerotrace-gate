// Evidence connectors against local stand-ins for GitHub, GitLab, Jira and CI: what a sync fetches, how it builds the
// bundle, provenance, dedupe, auto-audit, sync-then-audit schedules, failures, the worker path, and the outbound guards.
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { startFakeForge, SHA_NEW, SHA_OLD } from './fakeforge';
import { MemRepo } from '../lib/core/memRepo';
import { Services, HttpError } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { exportBundle, importBundle, parseCsv } from '../lib/core/bundle';
import { sha256, generateCorpus } from '../lib/engine';
import { DEFAULT_WORKSPACE } from '../lib/core/model';
import { sourceRuntime, secretRefProblem } from '../lib/server/connectors';
import { checkUrl, addressProblem, fetchGuarded } from '../lib/server/connectors/http';
import { issueToRow } from '../lib/server/connectors/jira';

const fails = async (p: Promise<unknown>, re: RegExp) => { try { await p; } catch (e) { assert.match((e as HttpError).message, re); return; } assert.fail(`expected ${re}`); };

(async () => {
  const corpus = generateCorpus({ seed: 178 });
  const forge = await startFakeForge(corpus); const base = forge.url; const port = forge.port;
  const { changed, exported, ciFiles } = forge; const seen = forge.seen;

  // ---------- outbound guards ----------
  assert.throws(() => checkUrl('http://169.254.169.254/latest/meta-data/'), /metadata/);
  assert.throws(() => checkUrl('https://metadata.google.internal/computeMetadata/v1/'), /metadata/);
  assert.throws(() => checkUrl('https://10.1.2.3/api'), /private/);
  assert.throws(() => checkUrl('https://user:pw@github.example.com'), /secret reference/);
  assert.throws(() => checkUrl('http://github.example.com'), /only use https/);
  assert.equal(addressProblem('::ffff:127.0.0.1', false), 'private, loopback or link-local address');
  assert.equal(addressProblem('fd00:ec2::254', true), 'cloud metadata endpoint', 'metadata stays blocked even for allowed hosts');
  assert.equal(addressProblem('140.82.112.3', false), null);
  process.env.CONNECTOR_ALLOWED_HOSTS = '127.0.0.1';
  await fails(fetchGuarded(`https://localhost:${port}/x`), /resolves to a private, loopback/);   // checked at connect time, not just by name
  assert.match(secretRefProblem('aws-sm://aerotrace/prod/db#url')!, /outside the secrets connectors may read/);
  assert.match(secretRefProblem('https://example.com/token')!, /not a secret reference/);
  assert.equal(secretRefProblem('env://CONNECTOR_GH_TOKEN'), null);
  process.env.CONNECTOR_SECRET_PREFIXES = 'aws-sm://aerotrace/connectors/,env://CONNECTOR_';
  assert.equal(secretRefProblem('aws-sm://aerotrace/connectors/github'), null);
  process.env.CONNECTOR_SECRET_PREFIXES = 'gcp-sm://projects/p1/secrets/aerotrace-prod-connector-,azure-kv://aerotrace-cn/,env://CONNECTOR_,aws-sm://aerotrace/connectors/';
  assert.equal(secretRefProblem('gcp-sm://projects/p1/secrets/aerotrace-prod-connector-github/versions/latest'), null);
  for (const sneaky of ['gcp-sm://projects/p1/secrets/aerotrace-prod-connector-x/../aerotrace-prod-session-secret/versions/latest',
    'gcp-sm://projects/p1/secrets/aerotrace-prod-connector-x%2f..%2fsession/versions/latest', 'azure-kv://aerotrace-cn/x/../../keys/signing',
    'aws-sm://aerotrace/connectors/../prod/db', 'env://CONNECTOR_X/../SESSION_SECRET'])
    assert.match(secretRefProblem(sneaky)!, /not a well-formed/, sneaky);
  console.log('guards: metadata, private and credential URLs refused; DNS checked at connect; token references limited to connector secrets');

  process.env.CONNECTOR_ALLOWED_HOSTS = '127.0.0.1,localhost';
  Object.assign(process.env, { CONNECTOR_GH_TOKEN: 'gh-token', CONNECTOR_JIRA_TOKEN: 'jira-token', CONNECTOR_GL_TOKEN: 'gl-token', CONNECTOR_JIRA_PAT: 'jira-pat', CONNECTOR_BAD: 'nope' });

  // Jira field mapping
  const row = issueToRow({ key: 'PR-9', fields: { summary: 'x', priority: { name: 'Major' }, status: { statusCategory: { key: 'done' } }, labels: ['module:YAW-DAMP', 'sev1', 'file:src/a.c'], customfield_1: 'src/b.c; src/c.c' } }, { moduleField: 'labels', filesField: 'customfield_1' });
  assert.deepEqual(row, { id: 'PR-9', module: 'YAW-DAMP', severity: 1, status: 'CLOSED', files: ['src/b.c', 'src/c.c', 'src/a.c'], title: 'x' });

  // ---------- services wired with the real connectors ----------
  const repo = new MemRepo();
  const root = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true, sources: sourceRuntime });
  await seed(repo, root, { demoUsers: true, syntheticDataset: false, hash: p => sha256(p) });
  const svc = root.forWorkspace(DEFAULT_WORKSPACE);
  const sam = await svc.actorFor((await repo.getUser('usr_sam'))!); const priya = await svc.actorFor((await repo.getUser('usr_priya'))!);
  const gh = { name: 'FCC-2 main', git: { provider: 'github' as const, baseUrl: base, repo: 'acme/fcc', ref: 'main', root: 'evidence', baselineRef: 'v1.0', tokenRef: 'env://CONNECTOR_GH_TOKEN' },
    jira: { baseUrl: base, deployment: 'cloud' as const, jql: 'project = FCC AND type = "Problem Report"', auth: 'basic' as const, email: 'qa@acme.example', tokenRef: 'env://CONNECTOR_JIRA_TOKEN' },
    ci: { kind: 'github-actions' as const, workflow: 'evidence.yml' } };

  await fails(svc.saveSource(priya, gh), /permission|not allowed|forbidden/i);
  await fails(svc.saveSource(sam, { ...gh, git: { ...gh.git, tokenRef: 'aws-sm://aerotrace/prod/db#url' } }), /outside the secrets connectors may read/);
  await fails(svc.saveSource(sam, { ...gh, git: { ...gh.git, baseUrl: 'http://169.254.169.254' } }), /metadata/);
  await fails(svc.saveSource(sam, { ...gh, git: { ...gh.git, repo: 'not a repo' } }), /owner\/name/);
  const src = await svc.saveSource(sam, gh);
  assert.ok(!JSON.stringify(src).includes('gh-token'), 'only the reference is stored');

  // Dry run stores nothing.
  const dry = await svc.testSource(sam, src.id);
  assert.ok(dry.ok, JSON.stringify(dry)); assert.equal(dry.commit, SHA_NEW); assert.equal((await svc.listDatasets()).length, 0);

  // First sync: a dataset version with full provenance.
  const r1 = await svc.requestSync(sam, src.id) as Awaited<ReturnType<Services['executeSync']>>;
  assert.equal(r1.status, 'ok'); assert.equal(r1.commit, SHA_NEW);
  const d1 = (await svc.listDatasets()).find(d => d.id === r1.datasetId)!;
  assert.equal(d1.name, 'FCC-2 main @ aaaaaaa'); assert.equal(d1.status, 'ready');
  assert.equal(d1.provenance!.git.baselineFrom, 'ref'); assert.equal(d1.provenance!.git.baselineCommit, SHA_OLD);
  assert.equal(d1.provenance!.jira!.issues, corpus.prs.length); assert.equal(d1.provenance!.ci!.junitFiles, Object.keys(ciFiles).filter(k => k.endsWith('.xml')).length);
  assert.match(d1.provenance!.ci!.run!, /runs\/77$/);
  const jiraPages = seen.filter(x => x.startsWith('GET /rest/api/3/search/jql')).length;
  assert.equal(jiraPages, Math.ceil(corpus.prs.length / 40) * 2, 'Jira paged with nextPageToken (dry run + sync)');
  assert.equal(forge.codeloadAuth, undefined, 'the token is not forwarded when the archive redirect changes host');
  const stored = Object.keys(unzipSync((await repo.getBundle(d1.id))!));
  assert.ok(stored.includes('bundle.json') && !stored.some(n => n.includes('escape') || n.includes('README.md')), 'only the bundle folder, no path escapes');
  // What came through matches the original evidence.
  const direct = await importBundle(await exportBundle(corpus));
  const synced = (await repo.getCorpus(d1.id))!;
  for (const k of ['High-level reqs', 'Low-level reqs', 'Source functions', 'Test cases', 'Test results', 'Coverage records', 'Problem reports']) assert.equal(synced.counts[k], direct.corpus.counts[k], k);
  assert.deepEqual(synced.prs.map(p => [p.id, p.sev, p.status, p.files.join(';')]), direct.corpus.prs.map(p => [p.id, p.sev, p.status, p.files.join(';')]));
  assert.deepEqual(synced.coverage, direct.corpus.coverage, 'coverage came through from the CI artifact');
  const drift = synced.cm.filter(c => c.baselineSha !== c.actualSha).map(c => c.file);
  assert.deepEqual(drift, [changed.slice('evidence/'.length)], 'drift since the v1.0 tag shows up as a configuration finding');
  console.log(`sync: ${d1.name}, ${synced.total} records; PRs from Jira (${jiraPages / 2} pages), tests+coverage from Actions run 77, baseline from v1.0 (1 file drifted)`);

  // Nothing changed: no new version.
  const r2 = await svc.requestSync(sam, src.id) as typeof r1;
  assert.equal(r2.status, 'unchanged'); assert.equal(r2.datasetId, d1.id); assert.equal((await svc.listDatasets()).length, 1);

  // A new Jira issue is new evidence; auto-audit runs on it.
  const mod = synced.modules[0].id;
  await svc.saveSource(sam, { ...gh, id: src.id, autoAudit: { modules: [mod], layer2: 'heuristic' } });
  forge.issues = [...forge.issues, { key: 'PR-NEW-1', fields: { summary: 'Late finding', priority: { name: 'Highest' }, status: { statusCategory: { key: 'new' } }, components: [{ name: mod }], labels: [] } }];
  const r3 = await svc.requestSync(sam, src.id) as typeof r1;
  assert.equal(r3.status, 'ok'); assert.notEqual(r3.datasetId, d1.id); assert.equal(r3.runIds.length, 1);
  assert.equal((await svc.getRun(sam, r3.runIds[0])).module, mod);
  console.log('dedupe: unchanged inputs reuse the version; a new Jira issue makes a new version and auto-audits it');

  // Sync-then-audit schedule: always audits, on whatever the sync produced, and follows the newest version.
  const sch = await svc.saveSchedule(sam, { name: 'FCC nightly from Git', sourceId: src.id, datasetId: '', modules: [mod], layer2: 'heuristic', recurrence: { kind: 'daily', time: '02:00' }, timezone: 'UTC', enabled: true, skipIfPending: false, notifyOn: [] });
  assert.equal(sch.datasetId, r3.datasetId);
  const fired = await svc.runScheduleNow(sam, sch.id);
  assert.equal(fired.length, 1); assert.equal((await svc.getRun(sam, fired[0])).datasetId, r3.datasetId);
  await fails(svc.deleteSource(sam, src.id), /schedule syncs this source/);
  console.log('schedule: sync-then-audit fired one audit on the latest version');

  // GitLab + Jira Data Center + GitLab job artifacts.
  const gl = await svc.saveSource(sam, { name: 'FCC-2 GitLab', git: { provider: 'gitlab', baseUrl: base, repo: 'acme/flight/fcc', ref: 'main', root: 'evidence', tokenRef: 'env://CONNECTOR_GL_TOKEN' },
    jira: { baseUrl: base, deployment: 'server', jql: 'project = FCC', auth: 'bearer', tokenRef: 'env://CONNECTOR_JIRA_PAT' }, ci: { kind: 'gitlab', job: 'evidence' } });
  const r4 = await svc.requestSync(sam, gl.id) as typeof r1;
  const d4 = (await svc.listDatasets()).find(d => d.id === r4.datasetId)!;
  assert.equal(d4.provenance!.git.provider, 'gitlab'); assert.equal(d4.provenance!.jira!.issues, forge.issues.length); assert.equal(d4.provenance!.git.baselineFrom, 'none');
  assert.ok(r4.warnings.some(w => /GitLab does not tie them to commit/.test(w)));
  console.log(`gitlab: ${d4.name} with Jira Data Center (offset paging) and job artifacts`);

  // Failures are recorded on the source and in the audit log, with a useful message.
  const bad = await svc.saveSource(sam, { ...gh, name: 'Wrong token', git: { ...gh.git, tokenRef: 'env://CONNECTOR_BAD' } });
  await fails(svc.requestSync(sam, bad.id), /answered 401 \(check the token reference\): Bad credentials/);
  assert.equal((await repo.getSource(bad.id))!.lastSync!.status, 'failed');
  const noRoot = await svc.saveSource(sam, { ...gh, name: 'Wrong folder', git: { ...gh.git, root: 'docs' } });
  await fails(svc.requestSync(sam, noRoot.id), /Nothing under "docs"/);
  const noJiraAuth = await svc.saveSource(sam, { ...gh, name: 'Wrong Jira', jira: { ...gh.jira, email: 'someone@acme.example' } });
  await fails(svc.requestSync(sam, noJiraAuth.id), /Jira answered 401.*not authenticated/);
  assert.ok((await svc.auditLog(sam, 200)).some(e => e.action === 'source.sync_failed' && e.target === bad.id));
  console.log('failures: bad token, wrong folder and Jira auth are reported on the source and audit-logged');

  // Another workspace sees none of it.
  await repo.updateUser('usr_sam', { platformAdmin: true });
  const ws = await root.createWorkspace(await svc.actorFor((await repo.getUser('usr_sam'))!), { name: 'Other program' });
  const B = root.forWorkspace(ws.id); const samB = await B.actorFor((await repo.getUser('usr_sam'))!);
  assert.equal((await B.listSources()).length, 0); await fails(B.requestSync(samB, src.id), /not found/i);

  // The worker path: queued, then executed by root, which routes to the source's workspace.
  const queued = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, sources: sourceRuntime });
  const qsvc = queued.forWorkspace(DEFAULT_WORKSPACE);
  forge.issues = [...forge.issues, { key: 'PR-NEW-2', fields: { summary: 'Another', priority: { name: 'Low' }, status: { statusCategory: { key: 'new' } }, components: [{ name: mod }], labels: [] } }];
  assert.deepEqual(await qsvc.requestSync(await qsvc.actorFor((await repo.getUser('usr_sam'))!), src.id), { queued: true });
  const job = (await repo.claimJob('w1'))!; assert.equal(job.kind, 'sync');
  const r5 = await queued.executeSync(String(job.payload.sourceId), { requestedBy: String(job.payload.requestedBy) });
  assert.equal(r5.status, 'ok'); assert.equal((await repo.getDataset(r5.datasetId))!.workspaceId, DEFAULT_WORKSPACE);

  // The browser demo has no connectors.
  const demo = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true }).forWorkspace(DEFAULT_WORKSPACE);
  await fails(demo.requestSync(await demo.actorFor((await repo.getUser('usr_sam'))!), src.id), /needs the deployed server/);
  void parseCsv;

  await forge.stop();
  console.log('connectors: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
