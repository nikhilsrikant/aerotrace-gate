// Evidence connectors: build an evidence bundle from where the program's evidence actually lives.
//   git   requirements, design, source, plans and bundle.json at a branch, tag or commit (optionally under a folder)
//   cm    cm/baseline.csv from the repo, or computed from the files at a baseline tag (so drift since that tag shows up)
//   jira  problem reports from a JQL query, replacing prs/problem_reports.csv
//   ci    JUnit and coverage from the CI run for that commit, replacing tests/ and coverage/
// The output is an ordinary bundle zip plus provenance, so it imports exactly like an upload.
import { createHash } from 'node:crypto';
import { zipSync, strFromU8, strToU8 } from 'fflate';
import type { EvidenceSource, Provenance } from '../../core/model';
import { toCsv } from '../../core/bundle';
import { sha256 } from '../../engine';
import { resolveRef } from '../cloud/secrets';
import { fetchRepo, fetchTree, resolveCommit } from './git';
import { searchJira, issueToRow } from './jira';
import { fetchCI } from './ci';
import { ConnectorError, checkUrl } from './http';

export { ConnectorError } from './http';
export interface SyncOutput { bundle: Uint8Array; provenance: Omit<Provenance, 'sourceId' | 'sourceName' | 'fetchedAt'>; warnings: string[] }
export interface SourceRuntime {
  /** Build the bundle for a source. */
  sync(src: EvidenceSource): Promise<SyncOutput>;
  /** Problems with a source's configuration that only the server can judge (URLs, secret references), or [] when fine. */
  check(src: EvidenceSource): string[];
}

const SRC = /\.(c|h|adb|ads|cpp|hpp)$/i;
const SCHEMES = /^(aws-sm|azure-kv|gcp-sm|env|file):\/\//;

/** Which secret references a source may name. Connector tokens are sent to administrator-chosen hosts, so a source
 *  must never be able to name the database password or session secret. Operators widen this with CONNECTOR_SECRET_PREFIXES. */
const SHAPES: Record<string, RegExp> = {
  'aws-sm': /^aws-sm:\/\/[A-Za-z0-9/_+=.@-]+(#[A-Za-z0-9_.-]+)?$/,
  'azure-kv': /^azure-kv:\/\/[A-Za-z0-9-]{3,24}\/[A-Za-z0-9-]{1,127}(\/[0-9a-fA-F]{32})?$/,
  'gcp-sm': /^gcp-sm:\/\/projects\/[A-Za-z0-9-]+\/secrets\/[A-Za-z0-9_-]+\/versions\/(latest|\d+)$/,
  env: /^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/,
  file: /^file:\/\/\/[A-Za-z0-9/_.-]+$/,
};
export function secretRefProblem(ref: string): string | null {
  if (!SCHEMES.test(ref)) return `"${ref}" is not a secret reference. Use aws-sm://, azure-kv://, gcp-sm:// or env://.`;
  // The prefix check below is only meaningful if the reference can't walk out of the prefix: exact shapes, no ".." segments.
  const scheme = ref.slice(0, ref.indexOf(':'));
  if (!SHAPES[scheme].test(ref) || ref.split(/[/#]/).some(p => p === '..' || p === '.')) return `"${ref}" is not a well-formed ${scheme}:// reference.`;
  const prefixes = (process.env.CONNECTOR_SECRET_PREFIXES || 'env://CONNECTOR_').split(',').map(s => s.trim()).filter(Boolean);
  if (!prefixes.some(p => ref.startsWith(p))) return `"${ref}" is outside the secrets connectors may read (CONNECTOR_SECRET_PREFIXES: ${prefixes.join(', ')}).`;
  return null;
}
async function token(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  const p = secretRefProblem(ref); if (p) throw new ConnectorError(p);
  try { return await resolveRef(ref); } catch (e) { throw new ConnectorError(`Could not read the secret ${ref}: ${(e as Error).message}`); }
}

export function checkSource(src: EvidenceSource): string[] {
  const out: string[] = [];
  const url = (u: string | undefined, what: string) => { if (!u) return; try { checkUrl(u); } catch (e) { out.push(`${what}: ${(e as Error).message}`); } };
  const ref = (r: string | undefined, what: string) => { if (!r) return; const p = secretRefProblem(r); if (p) out.push(`${what}: ${p}`); };
  url(src.git.baseUrl, 'Git server'); ref(src.git.tokenRef, 'Git token');
  if (src.jira) { url(src.jira.baseUrl, 'Jira'); ref(src.jira.tokenRef, 'Jira token'); }
  if (src.ci) { (src.ci.junitUrls ?? []).forEach(u => url(u, 'JUnit URL')); url(src.ci.coverageUrl, 'Coverage URL'); ref(src.ci.tokenRef, 'CI token'); }
  return out;
}

export async function syncSource(src: EvidenceSource): Promise<SyncOutput> {
  const problems = checkSource(src); if (problems.length) throw new ConnectorError(problems.join(' '));
  const warnings: string[] = [];
  const gitToken = await token(src.git.tokenRef);
  const { commit, files } = await fetchRepo(src.git, src.git.ref, gitToken);
  if (!files.has('bundle.json')) throw new ConnectorError(`bundle.json is missing at ${src.git.root ? src.git.root + '/' : ''}bundle.json in ${src.git.repo}@${commit.slice(0, 12)}.`);

  // Configuration baseline
  let baselineFrom: Provenance['git']['baselineFrom'] = files.has('cm/baseline.csv') ? 'bundle' : 'none'; let baselineCommit: string | null = null;
  if (src.git.baselineRef) {
    baselineCommit = await resolveCommit(src.git, src.git.baselineRef, gitToken);
    const old = baselineCommit === commit ? files : await fetchTree(src.git, baselineCommit, gitToken);
    const rows: string[][] = [];
    for (const [p, d] of [...old].sort(([a], [b]) => a.localeCompare(b))) if (SRC.test(p)) rows.push([p, await sha256(strFromU8(d))]);
    files.set('cm/baseline.csv', strToU8(toCsv(['file', 'sha256'], rows))); baselineFrom = 'ref';
  }

  // Problem reports
  let jira: Provenance['jira'] = null;
  if (src.jira) {
    const issues = await searchJira(src.jira, (await token(src.jira.tokenRef))!);
    const rows = issues.map(i => issueToRow(i, src.jira!));
    const noModule = rows.filter(r => !r.module); if (noModule.length) warnings.push(`${noModule.length} Jira issue(s) have no module (${noModule.slice(0, 5).map(r => r.id).join(', ')}); they were skipped`);
    files.set('prs/problem_reports.csv', strToU8(toCsv(['id', 'module', 'severity', 'status', 'files', 'title'], rows.filter(r => r.module).map(r => [r.id, r.module, r.severity, r.status, r.files.join(';'), r.title]))));
    jira = { baseUrl: src.jira.baseUrl, jql: src.jira.jql, issues: issues.length };
  }

  // Test results and coverage
  let ci: Provenance['ci'] = null;
  if (src.ci) {
    const r = await fetchCI(src.ci, src.git, commit, (await token(src.ci.tokenRef)) ?? (src.ci.kind !== 'urls' ? gitToken : undefined));
    warnings.push(...r.warnings);
    const junit = [...r.files.keys()].filter(k => k.startsWith('tests/'));
    if (!junit.length) warnings.push('The CI results held no JUnit XML; the repository\'s tests/ folder was kept');
    else for (const k of [...files.keys()]) if (k.startsWith('tests/')) files.delete(k);
    if ([...r.files.keys()].some(k => k.startsWith('coverage/'))) for (const k of [...files.keys()]) if (k.startsWith('coverage/')) files.delete(k);
    for (const [k, v] of r.files) files.set(k, v);
    ci = { kind: src.ci.kind, run: r.run, artifact: r.artifact, junitFiles: junit.length, coverage: [...r.files.keys()].some(k => k.startsWith('coverage/')) };
  }

  // Fingerprint of everything that goes into the bundle: an unchanged fingerprint means nothing to re-import.
  const h = createHash('sha256');
  for (const [p, d] of [...files].sort(([a], [b]) => a.localeCompare(b))) h.update(p).update('\0').update(createHash('sha256').update(d).digest('hex')).update('\n');
  const inputsSha256 = h.digest('hex');
  const bundle = zipSync(Object.fromEntries(files), { level: 6 });
  return { bundle, warnings, provenance: { inputsSha256, git: { provider: src.git.provider, repo: src.git.repo, ref: src.git.ref, commit, root: src.git.root ?? '', baselineRef: src.git.baselineRef ?? null, baselineCommit, baselineFrom }, jira, ci } };
}

export const sourceRuntime: SourceRuntime = { sync: syncSource, check: checkSource };
