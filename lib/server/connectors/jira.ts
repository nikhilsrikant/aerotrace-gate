// Jira: a JQL query becomes prs/problem_reports.csv. Cloud uses the enhanced search (/rest/api/3/search/jql, token
// paging); Server and Data Center use /rest/api/2/search (offset paging).
//   id        issue key
//   module    first component (default), a "module:<ID>" label, or a custom field
//   severity  priority: Highest/Blocker/Critical -> 1, High/Major -> 2, anything else -> 3 (a sev1/sev2/sev3 label wins)
//   status    OPEN unless the status category is Done
//   files     a custom field (text or list; ; , or newlines) and/or "file:<path>" labels
import type { EvidenceSource } from '../../core/model';
import { fetchGuarded, ConnectorError } from './http';

type Jira = NonNullable<EvidenceSource['jira']>;
export interface JiraIssue { key: string; fields: Record<string, unknown> }
export interface PRRow { id: string; module: string; severity: number; status: 'OPEN' | 'CLOSED'; files: string[]; title: string }

const MAX = 20000;
export const jiraAuth = (j: Jira, token: string) => ({ authorization: j.auth === 'basic' ? `Basic ${Buffer.from(`${j.email ?? ''}:${token}`).toString('base64')}` : `Bearer ${token}`, accept: 'application/json' });

export async function searchJira(j: Jira, token: string): Promise<JiraIssue[]> {
  const base = j.baseUrl.replace(/\/$/, ''); const headers = jiraAuth(j, token);
  const fields = ['summary', 'status', 'priority', 'components', 'labels', j.moduleField, j.filesField].filter((f): f is string => !!f && f !== 'components' && f !== 'labels').concat(['components', 'labels']);
  const out: JiraIssue[] = [];
  if (j.deployment === 'cloud') {
    let token2: string | undefined;
    do {
      const q = new URLSearchParams({ jql: j.jql, fields: [...new Set(fields)].join(','), maxResults: '100' }); if (token2) q.set('nextPageToken', token2);
      const r = (await fetchGuarded(`${base}/rest/api/3/search/jql?${q}`, { headers, what: 'Jira' })).json<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>();
      out.push(...r.issues); token2 = r.isLast ? undefined : r.nextPageToken;
    } while (token2 && out.length < MAX);
  } else {
    let startAt = 0, total = Infinity;
    while (startAt < total && out.length < MAX) {
      const q = new URLSearchParams({ jql: j.jql, fields: [...new Set(fields)].join(','), maxResults: '100', startAt: String(startAt) });
      const r = (await fetchGuarded(`${base}/rest/api/2/search?${q}`, { headers, what: 'Jira' })).json<{ issues: JiraIssue[]; total: number; maxResults: number }>();
      out.push(...r.issues); total = r.total; if (!r.issues.length) break; startAt += r.issues.length;
    }
  }
  if (out.length >= MAX) throw new ConnectorError(`The JQL query matches more than ${MAX} issues. Narrow it to this program's problem reports.`);
  return out;
}

const text = (v: unknown): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(text);
  if (typeof v === 'object') { const o = v as Record<string, unknown>; return text(o.value ?? o.name ?? o.key ?? ''); }
  return String(v).split(/[;,\n]+/).map(s => s.trim()).filter(Boolean);
};

export function issueToRow(i: JiraIssue, j: Pick<Jira, 'moduleField' | 'filesField'>): PRRow {
  const f = i.fields; const labels = (f.labels as string[] | undefined) ?? [];
  const mf = j.moduleField || 'components';
  const module = mf === 'labels' ? (labels.find(l => /^module:/i.test(l))?.slice(7) ?? '') : (text(f[mf])[0] ?? '');
  const prio = String((f.priority as { name?: string } | undefined)?.name ?? '').toLowerCase();
  const sevLabel = labels.map(l => /^sev([123])$/i.exec(l)?.[1]).find(Boolean);
  const severity = sevLabel ? Number(sevLabel) : /highest|blocker|critical|p1\b/.test(prio) ? 1 : /high|major|p2\b/.test(prio) ? 2 : 3;
  const cat = String(((f.status as { statusCategory?: { key?: string } } | undefined)?.statusCategory?.key) ?? '');
  const files = [...(j.filesField ? text(f[j.filesField]) : []), ...labels.filter(l => /^file:/i.test(l)).map(l => l.slice(5))];
  return { id: i.key, module, severity, status: cat === 'done' ? 'CLOSED' : 'OPEN', files: [...new Set(files)], title: String(f.summary ?? i.key) };
}
