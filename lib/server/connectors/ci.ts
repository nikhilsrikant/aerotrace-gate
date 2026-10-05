// CI results: JUnit XML and coverage for the commit being synced.
//   github-actions  the named artifact of a successful run for that exact commit (optionally one workflow file)
//   gitlab          the artifacts of the named job's latest successful pipeline on the ref
//   urls            plain links to JUnit files and a coverage file (an artifact store, Jenkins, Artifactory, ...)
// Files land as tests/<name>.xml and coverage/coverage.csv or coverage/lcov.info, replacing whatever the repo had.
import { unzipSync } from 'fflate';
import type { EvidenceSource } from '../../core/model';
import { fetchGuarded, ConnectorError } from './http';
import { githubApi, gitlabApi, githubHeaders, gitlabHeaders } from './git';

type CI = NonNullable<EvidenceSource['ci']>;
export interface CIResult { files: Map<string, Uint8Array>; run: string | null; artifact: string | null; warnings: string[] }

const base = (p: string) => p.split('/').pop()!.replace(/[^A-Za-z0-9._-]/g, '_');
function place(name: string, data: Uint8Array, out: Map<string, Uint8Array>) {
  const b = base(name).toLowerCase();
  if (b.endsWith('.xml')) out.set(`tests/${base(name)}`, data);
  else if (b === 'lcov.info' || b.endsWith('.lcov')) out.set('coverage/lcov.info', data);
  else if (b.endsWith('.csv') && b.includes('coverage')) out.set('coverage/coverage.csv', data);
}
function unpack(bytes: Buffer, what: string, out: Map<string, Uint8Array>) {
  let z: Record<string, Uint8Array>; try { z = unzipSync(new Uint8Array(bytes)); } catch { throw new ConnectorError(`${what} is not a zip archive.`); }
  for (const [n, d] of Object.entries(z)) if (!n.endsWith('/')) place(n, d, out);
}

export async function fetchCI(ci: CI, git: EvidenceSource['git'], commit: string, token?: string): Promise<CIResult> {
  const files = new Map<string, Uint8Array>(); const warnings: string[] = [];
  if (ci.kind === 'github-actions') {
    if (git.provider !== 'github') throw new ConnectorError('GitHub Actions results need a GitHub repository.');
    const api = `${githubApi(git)}/repos/${git.repo}`; const h = githubHeaders(token);
    const list = (q: string) => fetchGuarded(`${api}/actions/${ci.workflow ? `workflows/${encodeURIComponent(ci.workflow)}/` : ''}runs?status=success&per_page=1&${q}`, { headers: h, what: 'GitHub Actions' })
      .then(r => r.json<{ workflow_runs: { id: number; head_sha: string; html_url: string }[] }>().workflow_runs[0]);
    let run = await list(`head_sha=${commit}`);
    if (!run) {
      run = await list(`branch=${encodeURIComponent(git.ref)}`);
      if (!run) throw new ConnectorError(`No successful GitHub Actions run for ${git.repo} at ${commit.slice(0, 12)} or on ${git.ref}.`);
      warnings.push(`CI results come from run ${run.id} at ${run.head_sha.slice(0, 12)}, not the synced commit ${commit.slice(0, 12)}: no successful run exists for that commit yet`);
    }
    const name = ci.artifact || 'aerotrace-evidence';
    const arts = (await fetchGuarded(`${api}/actions/runs/${run.id}/artifacts?name=${encodeURIComponent(name)}`, { headers: h, what: 'GitHub Actions artifacts' })).json<{ artifacts: { name: string; archive_download_url: string; expired: boolean }[] }>().artifacts;
    const art = arts.find(a => a.name === name && !a.expired);
    if (!art) throw new ConnectorError(`Run ${run.id} has no artifact called "${name}" (or it expired).`);
    unpack((await fetchGuarded(art.archive_download_url, { headers: h, what: `artifact ${name}` })).body, `Artifact ${name}`, files);
    return { files, run: run.html_url || String(run.id), artifact: name, warnings };
  }
  if (ci.kind === 'gitlab') {
    if (git.provider !== 'gitlab') throw new ConnectorError('GitLab job artifacts need a GitLab project.');
    if (!ci.job) throw new ConnectorError('Name the GitLab job whose artifacts hold the test results.');
    const url = `${gitlabApi(git)}/projects/${encodeURIComponent(git.repo)}/jobs/artifacts/${encodeURIComponent(git.ref)}/download?job=${encodeURIComponent(ci.job)}`;
    unpack((await fetchGuarded(url, { headers: gitlabHeaders(token), what: `GitLab job ${ci.job}` })).body, `Artifacts of job ${ci.job}`, files);
    warnings.push(`CI results are the latest successful "${ci.job}" job on ${git.ref}; GitLab does not tie them to commit ${commit.slice(0, 12)}`);
    return { files, run: `${git.ref}:${ci.job}`, artifact: ci.job, warnings };
  }
  const h: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  for (const u of ci.junitUrls ?? []) { const r = await fetchGuarded(u, { headers: h, what: 'JUnit download' }); const n = base(new URL(r.url).pathname) || 'results.xml'; files.set(`tests/${n.endsWith('.xml') ? n : n + '.xml'}`, new Uint8Array(r.body)); }
  if (ci.coverageUrl) { const r = await fetchGuarded(ci.coverageUrl, { headers: h, what: 'coverage download' }); const looksLcov = /^(TN|SF):/m.test(r.text().slice(0, 2000)); files.set(looksLcov ? 'coverage/lcov.info' : 'coverage/coverage.csv', new Uint8Array(r.body)); }
  return { files, run: null, artifact: null, warnings };
}
