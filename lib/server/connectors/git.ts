// Git hosts: resolve a branch, tag or commit to a commit id, then download the tree at that commit as one archive.
// GitHub (github.com and Enterprise Server) and GitLab (gitlab.com and self-managed). No git binary, no clone.
import { unzipSync } from 'fflate';
import type { EvidenceSource } from '../../core/model';
import { fetchGuarded, ConnectorError } from './http';

type Git = EvidenceSource['git'];
export interface Tree { commit: string; files: Map<string, Uint8Array> }

export function githubApi(g: { baseUrl?: string }) {
  const b = (g.baseUrl || 'https://github.com').replace(/\/$/, '');
  return /^https:\/\/github\.com$/i.test(b) ? 'https://api.github.com' : /\/api\/v3$/.test(b) || /api\.github\.com$/.test(b) ? b : `${b}/api/v3`;
}
export function gitlabApi(g: { baseUrl?: string }) { const b = (g.baseUrl || 'https://gitlab.com').replace(/\/$/, ''); return /\/api\/v4$/.test(b) ? b : `${b}/api/v4`; }
export const githubHeaders = (token?: string): Record<string, string> => ({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) });
export const gitlabHeaders = (token?: string): Record<string, string> => (token ? { 'private-token': token } : {});

export async function resolveCommit(g: Git, ref: string, token?: string): Promise<string> {
  if (g.provider === 'github') {
    const r = await fetchGuarded(`${githubApi(g)}/repos/${g.repo}/commits/${encodeURIComponent(ref)}`, { headers: githubHeaders(token), what: `GitHub (${g.repo}@${ref})` });
    return r.json<{ sha: string }>().sha;
  }
  const r = await fetchGuarded(`${gitlabApi(g)}/projects/${encodeURIComponent(g.repo)}/repository/commits/${encodeURIComponent(ref)}`, { headers: gitlabHeaders(token), what: `GitLab (${g.repo}@${ref})` });
  return r.json<{ id: string }>().id;
}

/** Files under `root` at a commit, keyed by their path relative to root. */
export async function fetchTree(g: Git, commit: string, token?: string): Promise<Map<string, Uint8Array>> {
  const url = g.provider === 'github' ? `${githubApi(g)}/repos/${g.repo}/zipball/${commit}` : `${gitlabApi(g)}/projects/${encodeURIComponent(g.repo)}/repository/archive.zip?sha=${commit}`;
  const r = await fetchGuarded(url, { headers: g.provider === 'github' ? githubHeaders(token) : gitlabHeaders(token), what: `${g.provider === 'github' ? 'GitHub' : 'GitLab'} archive of ${g.repo}` });
  let zip: Record<string, Uint8Array>; try { zip = unzipSync(new Uint8Array(r.body)); } catch { throw new ConnectorError(`The archive of ${g.repo} is not a valid zip.`); }
  const root = (g.root ?? '').replace(/^\/+|\/+$/g, ''); const prefix = root ? root + '/' : '';
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(zip)) {
    if (name.endsWith('/')) continue;
    const inRepo = name.slice(name.indexOf('/') + 1);     // archives wrap everything in one "<repo>-<sha>/" folder
    if (!inRepo.startsWith(prefix)) continue;
    const rel = inRepo.slice(prefix.length);
    if (!rel || rel.split('/').some(p => p === '..')) continue;
    out.set(rel, data);
  }
  if (!out.size) throw new ConnectorError(root ? `Nothing under "${root}" in ${g.repo} at ${commit.slice(0, 12)}.` : `${g.repo} at ${commit.slice(0, 12)} is empty.`);
  return out;
}

export async function fetchRepo(g: Git, ref: string, token?: string): Promise<Tree> {
  const commit = await resolveCommit(g, ref, token);
  return { commit, files: await fetchTree(g, commit, token) };
}
