// A stand-in for GitHub (Enterprise layout), GitLab, Jira (Cloud and Data Center) and CI artifacts, serving one program's
// evidence the way it would really be spread out: requirements/design/source in the repo under evidence/, test results
// and coverage only in CI, problem reports only in Jira, and an older tag (v1.0) where one source file differs.
// Used by tests/connectors.test.ts and, standalone (`tsx tests/fakeforge.ts 4598`), by the e2e run. Tokens it accepts:
// GitHub "gh-token", GitLab "gl-token", Jira Cloud basic qa@acme.example:"jira-token", Jira Data Center bearer "jira-pat".
import http from 'node:http';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { exportBundle } from '../lib/core/bundle';
import { generateCorpus } from '../lib/engine';
import type { Corpus } from '../lib/engine';

export const SHA_NEW = 'a'.repeat(40), SHA_OLD = 'b'.repeat(40);
export interface Forge { url: string; port: number; seen: string[]; codeloadAuth: string | undefined; issues: { key: string; fields: Record<string, unknown> }[];
  changed: string; exported: Record<string, Uint8Array>; ciFiles: Record<string, Uint8Array>; stop(): Promise<void> }

export async function startFakeForge(corpus: Corpus = generateCorpus({ seed: 178 }), port = 0): Promise<Forge> {
  const state = { seen: [] as string[], codeloadAuth: 'unset' as string | undefined, issues: [] as Forge['issues'], port: 0 };
  // ---------- fixtures: the program's evidence as it would sit in a repo, CI and Jira ----------
  const exported = unzipSync(await exportBundle(corpus));
  const repoFiles: Record<string, Uint8Array> = {}; const ciFiles: Record<string, Uint8Array> = {};
  for (const [p, d] of Object.entries(exported)) {
    if (p.startsWith('tests/')) ciFiles[`junit/${p.slice(6)}`] = d;                // test results only exist in CI
    else if (p === 'prs/problem_reports.csv' || p === 'cm/baseline.csv' || p.startsWith('coverage/')) continue;  // PRs in Jira, coverage in CI, baseline from a tag
    else repoFiles[`evidence/${p}`] = d;
  }
  repoFiles['README.md'] = strToU8('# FCC-2\n'); repoFiles['evidence/../escape.txt'] = strToU8('never');
  const srcPaths = Object.keys(repoFiles).filter(p => /\.(c|h)$/.test(p)).sort();
  const changed = srcPaths[0];                                                     // edited after the v1.0 tag
  const oldFiles = { ...repoFiles, [changed]: strToU8(strFromU8(repoFiles[changed]) + '\n/* before the fix */\n') };
  const archive = (files: Record<string, Uint8Array>, sha: string) => zipSync(Object.fromEntries(Object.entries(files).map(([p, d]) => [`acme-fcc-${sha.slice(0, 7)}/${p}`, d])));
  ciFiles['coverage.csv'] = exported['coverage/coverage.csv'];
  state.issues = corpus.prs.map(p => ({ key: p.id, fields: { summary: p.title, priority: { name: ['Highest', 'High', 'Medium'][p.sev - 1] }, status: { statusCategory: { key: p.status === 'OPEN' ? 'indeterminate' : 'done' } },
    components: [{ name: p.module }], labels: p.files.map(f => `file:${f}`) } }));

  // ---------- the stand-in servers ----------
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'); const p = u.pathname; state.seen.push(`${req.method} ${p}${u.search}`);
    const auth = req.headers.authorization ?? ''; const glTok = req.headers['private-token'];
    const send = (code: number, body: unknown, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body)); };
    const ghOk = auth === 'Bearer gh-token';
    // GitHub (Enterprise Server layout: /api/v3)
    let m = /^\/api\/v3\/repos\/acme\/fcc\/commits\/(.+)$/.exec(p);
    if (m) { if (!ghOk) return send(401, { message: 'Bad credentials' }); const r = decodeURIComponent(m[1]); return r === 'main' || r === SHA_NEW ? send(200, { sha: SHA_NEW }) : r === 'v1.0' || r === SHA_OLD ? send(200, { sha: SHA_OLD }) : send(404, { message: 'No commit found for SHA: ' + r }); }
    m = /^\/api\/v3\/repos\/acme\/fcc\/zipball\/([0-9a-f]+)$/.exec(p);
    if (m) { if (!ghOk) return send(401, {}); res.writeHead(302, { location: `http://localhost:${state.port}/codeload/${m[1]}` }); return res.end(); }
    m = /^\/codeload\/([0-9a-f]+)$/.exec(p);
    if (m) { state.codeloadAuth = req.headers.authorization; return send(200, archive(m[1] === SHA_NEW ? repoFiles : oldFiles, m[1]), 'application/zip'); }
    if (p === '/api/v3/repos/acme/fcc/actions/workflows/evidence.yml/runs') { if (!ghOk) return send(401, {}); return send(200, { workflow_runs: u.searchParams.get('head_sha') === SHA_NEW ? [{ id: 77, head_sha: SHA_NEW, html_url: `http://127.0.0.1:${state.port}/acme/fcc/actions/runs/77` }] : [] }); }
    if (p === '/api/v3/repos/acme/fcc/actions/runs/77/artifacts') return send(200, { artifacts: [{ name: 'aerotrace-evidence', expired: false, archive_download_url: `http://127.0.0.1:${state.port}/api/v3/repos/acme/fcc/actions/artifacts/9/zip` }] });
    if (p === '/api/v3/repos/acme/fcc/actions/artifacts/9/zip') { if (!ghOk) return send(401, {}); return send(200, zipSync(ciFiles), 'application/zip'); }
    // GitLab
    if (p === '/api/v4/projects/acme%2Fflight%2Ffcc/repository/commits/main') return glTok === 'gl-token' ? send(200, { id: SHA_NEW }) : send(401, { message: '401 Unauthorized' });
    if (p === '/api/v4/projects/acme%2Fflight%2Ffcc/repository/archive.zip') return send(200, archive(repoFiles, u.searchParams.get('sha')!), 'application/zip');
    if (p === '/api/v4/projects/acme%2Fflight%2Ffcc/jobs/artifacts/main/download' && u.searchParams.get('job') === 'evidence') return send(200, zipSync(ciFiles), 'application/zip');
    // Jira Cloud (enhanced search, token paging) and Data Center (offset paging)
    if (p === '/rest/api/3/search/jql') {
      if (auth !== 'Basic ' + Buffer.from('qa@acme.example:jira-token').toString('base64')) return send(401, { errorMessages: ['You are not authenticated.'] });
      const start = Number(u.searchParams.get('nextPageToken') ?? 0); const page = state.issues.slice(start, start + 40); const next = start + 40;
      return send(200, next < state.issues.length ? { issues: page, nextPageToken: String(next), isLast: false } : { issues: page, isLast: true });
    }
    if (p === '/rest/api/2/search') {
      if (auth !== 'Bearer jira-pat') return send(401, { errorMessages: ['Unauthorized'] });
      const start = Number(u.searchParams.get('startAt')); return send(200, { issues: state.issues.slice(start, start + 25), total: state.issues.length, startAt: start, maxResults: 25 });
    }
    send(404, { message: `no route ${p}` });
  });
  await new Promise<void>(r => srv.listen(port, '127.0.0.1', () => r())); state.port = (srv.address() as { port: number }).port;
  return Object.assign(state, { url: `http://127.0.0.1:${state.port}`, changed, exported, ciFiles, stop: () => new Promise<void>(r => srv.close(() => r())) }) as unknown as Forge;
}

if (process.argv[1]?.endsWith('fakeforge.ts')) startFakeForge(undefined, Number(process.argv[2] || 4598)).then(f => console.log(`fake forge on ${f.url}`));
