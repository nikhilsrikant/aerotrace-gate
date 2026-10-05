import { ApiError, type Api } from './api';
import { createPasskey, usePasskey } from './passkeyBrowser';

async function call<T>(method: string, path: string, data?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { 'x-aerotrace-csrf': '1' }, cache: 'no-store', credentials: 'same-origin' };
  if (data instanceof FormData) init.body = data;
  else if (data !== undefined) { init.body = JSON.stringify(data); (init.headers as Record<string, string>)['content-type'] = 'application/json'; }
  const res = await fetch(`/api${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const b = body as { error?: string; code?: string }; throw new ApiError(b.error || `Request failed (${res.status})`, res.status, b.code); }
  return body as T;
}
const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const get = <T,>(p: string) => call<T>('GET', p);
const post = <T,>(p: string, d?: unknown) => call<T>('POST', p, d ?? {});
const put = <T,>(p: string, d: unknown) => call<T>('PUT', p, d);
const del = (p: string) => call<void>('DELETE', p);

export const httpApi: Api = {
  mode: 'server',
  authConfig: () => get('/auth/config'),
  me: async () => { const r = await get<{ user: null } | { user: object; permissions: string[]; mustChangePassword: boolean }>('/auth/me'); return r.user ? r as never : null; },
  login: async (email, password) => { await post('/auth/login', { email, password }); },
  logout: async () => { await post('/auth/logout'); },
  changePassword: async (current, next) => { await post('/auth/password', { current, next }); },
  ssoUrl: () => '/api/auth/sso/start',
  passkeyLogin: async () => { const o = await post<{ challengeId: string; options: never }>('/auth/passkey/login/options'); await post('/auth/passkey/login', { challengeId: o.challengeId, response: await usePasskey(o.options) }); },
  enrollPasskey: async name => { const o = await post<{ challengeId: string; options: never }>('/auth/passkey/register/options'); return post('/auth/passkey/register', { challengeId: o.challengeId, response: await createPasskey(o.options), name }); },
  verifyPasskey: async () => { const o = await post<{ challengeId: string; options: never }>('/auth/passkey/verify/options'); await post('/auth/passkey/verify', { challengeId: o.challengeId, response: await usePasskey(o.options) }); },
  passkeys: () => get('/auth/passkeys'),
  renamePasskey: async (id, name) => { await call('PATCH', `/auth/passkeys/${id}`, { name }); },
  removePasskey: id => del(`/auth/passkeys/${id}`),
  resetPasskeys: id => post(`/users/${id}/passkeys/reset`),
  createInvite: (id, hours) => post(`/users/${id}/invite`, { hours }),
  redeemInvite: async token => { await post('/auth/invite', { token }); },
  fetchFile: async url => { const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' }); if (!res.ok) { const b = await res.json().catch(() => ({})) as { error?: string; code?: string }; throw new ApiError(b.error || `Download failed (${res.status})`, res.status, b.code); } return res.blob(); },
  meta: () => get('/meta'),
  directory: () => get('/directory'),
  datasets: () => get('/datasets'),
  uploadDataset: (name, file) => { const f = new FormData(); f.set('name', name); f.set('file', file); return call('POST', '/datasets', f); },
  createSynthetic: (name, seed) => post('/datasets', { name, seed }),
  deleteDataset: id => del(`/datasets/${id}`),
  sources: () => get('/sources'),
  saveSource: s => (s.id ? put(`/sources/${s.id}`, s) : post('/sources', s)),
  deleteSource: id => del(`/sources/${id}`),
  syncSource: id => post(`/sources/${id}/sync`),
  testSource: id => post(`/sources/${id}/test`),
  sampleUrl: () => '/api/datasets/sample',
  runs: status => get(`/runs${status?.length ? `?status=${status.join(',')}` : ''}`),
  inbox: () => get('/inbox'),
  run: id => get(`/runs/${id}`),
  startAudits: i => post('/runs', i),
  decide: async (id, action, reason) => {
    const o = await post<{ challengeId: string; options: never }>(`/runs/${id}/decision/options`, { action, reason });
    return post(`/runs/${id}/decision`, { action, reason, passkey: { challengeId: o.challengeId, response: await usePasskey(o.options) } });
  },
  verify: id => get(`/runs/${id}/verify`),
  diff: id => get(`/runs/${id}/diff`),
  reportUrl: id => `/api/runs/${id}/report`,
  evidenceUrl: id => `/api/runs/${id}/evidence`,
  evidence: id => get(`/runs/${id}/evidence`),
  schedules: () => get('/schedules'),
  saveSchedule: s => (s.id ? put(`/schedules/${s.id}`, s) : post('/schedules', s)),
  deleteSchedule: id => del(`/schedules/${id}`),
  runSchedule: id => post(`/schedules/${id}/run`),
  policies: () => get('/policies'),
  savePolicy: p => (p.id ? put(`/policies/${p.id}`, p) : post('/policies', p)),
  deletePolicy: id => del(`/policies/${id}`),
  simulate: f => post('/policies/simulate', f),
  delegations: () => get('/delegations'),
  createDelegation: d => post('/delegations', d),
  revokeDelegation: id => del(`/delegations/${id}`),
  users: () => get('/users'),
  createUser: i => post('/users', i),
  updateUser: async (id, p) => { await call('PATCH', `/users/${id}`, p); },
  groups: () => get('/groups'),
  saveGroup: async (g, memberIds) => { await (g.id ? put(`/groups/${g.id}`, { ...g, memberIds }) : post('/groups', { ...g, memberIds })); },
  deleteGroup: id => del(`/groups/${id}`),
  roles: () => get('/roles'),
  saveRole: async r => { await (r.id ? put(`/roles/${r.id}`, r) : post('/roles', r)); },
  deleteRole: id => del(`/roles/${id}`),
  tokens: () => get('/tokens'),
  createToken: i => post('/tokens', i),
  revokeToken: id => del(`/tokens/${id}`),
  settings: () => get('/settings'),
  saveSettings: async s => { await put('/settings', s); },
  workspaces: () => get('/workspaces'),
  createWorkspace: name => post('/workspaces', { name }),
  renameWorkspace: async (id, name) => { await call('PATCH', `/workspaces/${id}`, { name }); },
  switchWorkspace: async id => { await post(`/workspaces/${id}/switch`); },
  program: ds => get(`/program${ds ? `?dataset=${encodeURIComponent(ds)}` : ''}`),
  chaosDrill: (module, preset, datasetId) => post('/chaos', { module, preset, datasetId }),
  ask: (question, runId) => post('/assistant', { question, runId, timezone: tz() }),
  transcribe: async audio => { const f = new FormData(); f.set('audio', audio, 'question.webm'); return (await call<{ text: string }>('POST', '/assistant/transcribe', f)).text; },
  suggestions: () => get(`/automation/suggestions?tz=${encodeURIComponent(tz())}`),
  dismissSuggestion: async key => { await post('/automation/suggestions/dismiss', { key }); },
  auditLog: (limit, before) => get(`/audit-log?limit=${limit}${before ? `&before=${before}` : ''}`),
  verifyAuditLog: () => get('/audit-log/verify'),
};
