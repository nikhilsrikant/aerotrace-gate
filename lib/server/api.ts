// Every API endpoint, in one table. app/api/[...path]/route.ts dispatches here.
import { NextResponse, type NextRequest } from 'next/server';
import * as oidc from 'openid-client';
import { ctx } from './context';
import { route, body, startSession, SESSION_COOKIE, clientIp, sealed, unseal, secureCookies, wsvc } from './http';
import { HttpError, strip } from '../core/services';
import { llmStatus } from './llm';
import { exportBundle } from '../core/bundle';
import { generateCorpus, sha256 } from '../engine';
import { toMarkdown } from '../../ui/report';
import { ALL_PERMISSIONS, PERMISSIONS, STEP_UP_ACTIONS, type Actor } from '../core/model';
import { describeRecurrence } from '../core/schedule';
import { protocolSpec } from '../engine/protocol';
import { telemetry } from '../engine/telemetry';

const VERSION = process.env.AEROTRACE_VERSION || '3.0.0';
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 200) * 1024 * 1024;
const need = (a: Actor | null) => { if (!a) throw new HttpError(401, 'Sign in first.'); return a; };

// ---------- SSO (any OpenID Connect provider: Entra ID, Okta, Ping, Keycloak) ----------
let oidcConfig: Promise<oidc.Configuration> | null = null;
const oidcEnabled = () => !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID);
function oidcConf() {
  if (!oidcConfig) oidcConfig = oidc.discovery(new URL(process.env.OIDC_ISSUER!), process.env.OIDC_CLIENT_ID!, process.env.OIDC_CLIENT_SECRET || undefined).catch(e => { oidcConfig = null; throw e; });
  return oidcConfig;
}
const publicUrl = (req: NextRequest) => (process.env.PUBLIC_URL || req.nextUrl.origin).replace(/\/$/, '');

let sampleZip: Uint8Array | null = null;

type R = { method: string; path: string; h: ReturnType<typeof route> };
const routes: R[] = [];
const on = (method: string, path: string, h: ReturnType<typeof route>) => routes.push({ method, path, h });

// ---------- health ----------
on('GET', '/health', route(async () => ({ ok: true, version: VERSION }), { auth: false }));
on('GET', '/ready', route(async () => { await (await ctx()).repo.ping(); return { ok: true }; }, { auth: false }));
on('GET', '/metrics', route(async req => {
  const tok = process.env.METRICS_TOKEN; if (tok && req.headers.get('authorization') !== `Bearer ${tok}`) throw new HttpError(401, 'Metrics token required.');
  const { repo } = await ctx(); const pool = repo.pool;
  const runs = (await pool.query<{ status: string; verdict: string | null; n: string }>("SELECT status, data->>'verdict' verdict, count(*) n FROM runs GROUP BY 1,2")).rows;
  const q = await repo.queueStats();
  const pend = (await pool.query<{ age: string | null }>("SELECT EXTRACT(EPOCH FROM now() - min(created_at)) age FROM runs WHERE status='awaiting_approval'")).rows[0];
  const sch = (await pool.query<{ n: string; overdue: string }>("SELECT count(*) FILTER (WHERE enabled) n, count(*) FILTER (WHERE enabled AND next_run_at < now() - interval '10 minutes') overdue FROM schedules")).rows[0];
  const lines = [`aerotrace_build_info{version="${VERSION}"} 1`, '# TYPE aerotrace_runs gauge',
    ...runs.map(r => `aerotrace_runs{status="${r.status}",verdict="${r.verdict ?? 'none'}"} ${r.n}`),
    '# TYPE aerotrace_queue_jobs gauge', ...Object.entries(q).map(([k, v]) => `aerotrace_queue_jobs{status="${k}"} ${v}`),
    '# HELP aerotrace_oldest_pending_approval_seconds Age of the oldest audit waiting for a decision', `aerotrace_oldest_pending_approval_seconds ${Number(pend?.age ?? 0).toFixed(0)}`,
    `aerotrace_schedules_enabled ${sch.n}`, `aerotrace_schedules_overdue ${sch.overdue}`];
  return new Response(lines.join('\n') + '\n', { headers: { 'content-type': 'text/plain; version=0.0.4' } });
}, { auth: false }));
on('GET', '/protocol', route(async () => protocolSpec(), { auth: false }));
on('GET', '/keys', route(async () => { const svc = await wsvc(); const s = svc.d.signer; return { current: s.keyId, keys: s.publicKeys?.() ?? [s.publicKey()].filter(Boolean) }; }, { auth: false }));

// ---------- auth ----------
on('GET', '/auth/config', route(async () => ({ local: process.env.DISABLE_LOCAL_LOGIN !== 'true', sso: oidcEnabled() ? { label: process.env.OIDC_LABEL || 'Company single sign-on' } : null, version: VERSION }), { auth: false }));
on('POST', '/auth/login', route(async req => {
  if (process.env.DISABLE_LOCAL_LOGIN === 'true') throw new HttpError(403, 'Password sign-in is turned off. Use single sign-on.');
  const b = await body<{ email: string; password: string }>(req);
  const svc = await wsvc();
  const u = await svc.loginLocal(String(b.email || ''), String(b.password || ''), clientIp(req));
  const res = NextResponse.json({ user: strip(u) }); await startSession(res, u.id, req); return res;
}, { auth: false }));
on('POST', '/auth/logout', route(async req => {
  const { repo } = await ctx(); const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (raw) { const s = await repo.getSessionByHash(await sha256(raw)); if (s) await repo.deleteSession(s.id); }
  const res = NextResponse.json({ ok: true }); res.cookies.delete(SESSION_COOKIE); return res;
}, { auth: false }));
on('GET', '/auth/me', route(async (_req, { actor }) => {
  if (!actor) return { user: null };
  const { repo } = await ctx(); const u = await repo.getUser(actor.user.id);
  return { user: actor.user, permissions: [...actor.permissions], mustChangePassword: !!u?.mustChangePassword, via: actor.via, assurance: await (await wsvc()).assurance(actor) };
}, { auth: false }));
on('POST', '/auth/password', route(async (req, { actor }) => { const b = await body<{ current: string; next: string }>(req); await (await wsvc()).changePassword(need(actor), b.current, b.next); return { ok: true }; }, { gate: false }));

// ---------- passkeys ----------
// Sign in with a passkey alone (no username, no password).
on('POST', '/auth/passkey/login/options', route(async () => (await wsvc()).beginPasskeyLogin(), { auth: false }));
on('POST', '/auth/passkey/login', route(async req => {
  const b = await body<{ challengeId: string; response: never }>(req); const svc = await wsvc();
  const { user, passkeyId } = await svc.finishPasskeyLogin(b.challengeId, b.response, clientIp(req));
  const res = NextResponse.json({ user: strip(user) }); await startSession(res, user.id, req, { method: 'passkey', passkeyId }); return res;
}, { auth: false }));
// Enrol (first passkey right after password/SSO sign-in; more after a fresh check), and unlock or re-confirm a session.
on('POST', '/auth/passkey/register/options', route(async (_r, { actor }) => (await wsvc()).beginPasskeyRegistration(need(actor)), { gate: false }));
on('POST', '/auth/passkey/register', route(async (req, { actor }) => { const b = await body<{ challengeId: string; response: never; name?: string }>(req); return (await wsvc()).finishPasskeyRegistration(need(actor), b.challengeId, b.response, b.name); }, { gate: false }));
on('POST', '/auth/passkey/verify/options', route(async (_r, { actor }) => (await wsvc()).beginPasskeyVerify(need(actor)), { gate: false }));
on('POST', '/auth/passkey/verify', route(async (req, { actor }) => { const b = await body<{ challengeId: string; response: never }>(req); return (await wsvc()).finishPasskeyVerify(need(actor), b.challengeId, b.response); }, { gate: false }));
on('GET', '/auth/passkeys', route(async (_r, { actor }) => (await wsvc()).myPasskeys(need(actor))));
on('PATCH', '/auth/passkeys/:id', route(async (req, { actor, params }) => { const b = await body<{ name: string }>(req); await (await wsvc()).renamePasskey(need(actor), params.id, b.name); return { ok: true }; }));
on('DELETE', '/auth/passkeys/:id', route(async (_r, { actor, params }) => { await (await wsvc()).removePasskey(need(actor), params.id); return { ok: true }; }));
on('POST', '/users/:id/passkeys/reset', route(async (req, { actor, params }) => { const r = await (await wsvc()).resetPasskeys(need(actor), params.id); return { ...r, invite: { ...r.invite, url: `${publicUrl(req)}/#invite=${r.invite.token}` } }; }));
on('POST', '/users/:id/invite', route(async (req, { actor, params }) => { const b = await body<{ hours?: number }>(req); const r = await (await wsvc()).createInvite(need(actor), params.id, b.hours); return { ...r, url: `${publicUrl(req)}/#invite=${r.token}` }; }));
// Opening an invite link: a short session whose only use is setting up a passkey (the data gate still applies).
on('POST', '/auth/invite', route(async req => {
  const b = await body<{ token: string }>(req); const svc = await wsvc();
  const u = await svc.redeemInvite(String(b.token || ''), clientIp(req));
  const res = NextResponse.json({ user: strip(u) }); await startSession(res, u.id, req, { method: 'invite' }); return res;
}, { auth: false }));
on('GET', '/auth/sso/start', route(async req => {
  if (!oidcEnabled()) throw new HttpError(404, 'Single sign-on is not configured.');
  const conf = await oidcConf();
  const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(conf, { redirect_uri: `${publicUrl(req)}/api/auth/sso/callback`, scope: process.env.OIDC_SCOPES || 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state });
  const res = NextResponse.redirect(url.href);
  res.cookies.set('aero_sso', sealed({ verifier, state }), { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/api/auth/sso', maxAge: 600 });
  return res;
}, { auth: false }));
on('GET', '/auth/sso/callback', route(async req => {
  const conf = await oidcConf();
  const st = unseal<{ verifier: string; state: string }>(req.cookies.get('aero_sso')?.value);
  if (!st) throw new HttpError(400, 'The sign-in took too long or the browser blocked cookies. Start again.');
  const current = new URL(`${publicUrl(req)}/api/auth/sso/callback${req.nextUrl.search}`);
  const tokens = await oidc.authorizationCodeGrant(conf, current, { pkceCodeVerifier: st.verifier, expectedState: st.state });
  const c = (tokens.claims() ?? {}) as Record<string, unknown>;
  const email = String(c.email || c.preferred_username || c.upn || ''); if (!email.includes('@')) throw new HttpError(400, 'Your identity provider did not send an email address.');
  const claim = process.env.OIDC_GROUPS_CLAIM || 'groups';
  const groups = Array.isArray(c[claim]) ? (c[claim] as unknown[]).map(String) : [];
  const u = await (await wsvc()).upsertSsoUser(email, String(c.name || email), groups);
  const res = NextResponse.redirect(`${publicUrl(req)}/`); res.cookies.delete('aero_sso'); await startSession(res, u.id, req, { method: 'sso' }); return res;
}, { auth: false }));

// ---------- workspaces ----------
on('GET', '/workspaces', route(async (_r, { actor }) => { const svc = await wsvc(); return { current: svc.workspaceId, platformAdmin: !!need(actor).platformAdmin, workspaces: await svc.workspacesFor(need(actor).user) }; }, { gate: false }));
on('POST', '/workspaces', route(async (req, { actor }) => (await wsvc()).createWorkspace(need(actor), await body(req) as never)));
on('PATCH', '/workspaces/:id', route(async (req, { actor, params }) => { const b = await body<{ name: string }>(req); await (await wsvc()).renameWorkspace(need(actor), params.id, b.name); return { ok: true }; }));
on('POST', '/workspaces/:id/switch', route(async (_r, { actor, params }) => { await (await wsvc()).switchWorkspace(need(actor), params.id); return { ok: true }; }, { gate: false }));

// ---------- meta & directory ----------
on('GET', '/meta', route(async (_r, { actor }) => {
  const svc = await wsvc(); const { repo } = await ctx(); const s = await svc.getSettings(); const signer = svc.d.signer;
  const wss = await svc.workspacesFor(actor!.user);
  return { version: VERSION, orgName: s.orgName, workspace: wss.find(w => w.id === svc.workspaceId) ?? { id: svc.workspaceId, name: s.orgName }, workspaces: wss, platformAdmin: !!actor!.platformAdmin, llm: llmStatus(s), store: repo.kind, signer: { alg: signer.alg, keyId: signer.keyId },
    permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ id, label })), me: actor!.user, myPermissions: [...actor!.permissions], sso: oidcEnabled(), voice: { serverStt: !!process.env.STT_URL },
    stepUpActions: Object.entries(STEP_UP_ACTIONS).map(([id, label]) => ({ id, label })) };
}, { gate: false }));
on('GET', '/directory', route(async () => { const svc = await wsvc(); return { users: await svc.directoryNames(), groups: (await svc.listGroups()).map(g => ({ id: g.id, name: g.name })) }; }));

// ---------- datasets ----------
on('GET', '/datasets', route(async () => (await wsvc()).listDatasets()));
on('GET', '/datasets/sample', route(async () => {
  if (!sampleZip) { const c = generateCorpus({ total: 0 }); const keep = new Set(c.modules.slice(0, 3).map(m => m.id)); const f = <T extends { module: string }>(xs: T[]) => xs.filter(x => keep.has(x.module));
    const tests = f(c.tests), ids = new Set(tests.map(t => t.id)), fns = f(c.fns), fnIds = new Set(fns.map(x => x.id));
    sampleZip = await exportBundle({ ...c, modules: c.modules.filter(m => keep.has(m.id)), hlrs: f(c.hlrs), llrs: f(c.llrs), design: f(c.design), fns, tests, results: c.results.filter(r => ids.has(r.test)), coverage: c.coverage.filter(v => fnIds.has(v.fn)), prs: f(c.prs), cm: f(c.cm), plans: [], truth: [] }); }
  return new Response(Buffer.from(sampleZip), { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="aerotrace-sample-bundle.zip"' } });
}));
on('POST', '/datasets', route(async (req, { actor }) => {
  const svc = await wsvc(); const a = need(actor);
  if ((req.headers.get('content-type') || '').includes('application/json')) { const b = await body<{ name: string; seed?: number }>(req); return svc.createSyntheticDataset(a, b.name || 'Synthetic program', Number(b.seed) || 178); }
  const len = Number(req.headers.get('content-length') || 0); if (len > MAX_UPLOAD) throw new HttpError(413, `The upload is larger than ${MAX_UPLOAD / 1048576} MB.`);
  const form = await req.formData(); const file = form.get('file');
  if (!(file instanceof Blob)) throw new HttpError(400, 'Attach the evidence bundle as a .zip file.');
  if (file.size > MAX_UPLOAD) throw new HttpError(413, `The upload is larger than ${MAX_UPLOAD / 1048576} MB.`);
  return svc.registerBundle(a, String(form.get('name') || (file as File).name || 'Evidence bundle'), new Uint8Array(await file.arrayBuffer()));
}));
on('DELETE', '/datasets/:id', route(async (_r, { actor, params }) => { await (await wsvc()).deleteDataset(need(actor), params.id); return { ok: true }; }));

// ---------- audits ----------
on('GET', '/runs', route(async (req, { actor }) => {
  const st = req.nextUrl.searchParams.get('status');
  return (await wsvc()).listRuns(need(actor), { status: st ? st.split(',') as never : undefined, limit: Number(req.nextUrl.searchParams.get('limit') || 200), datasetId: req.nextUrl.searchParams.get('dataset') || undefined });
}));
on('POST', '/runs', route(async (req, { actor }) => { const b = await body<Record<string, never>>(req); return { runIds: await (await wsvc()).startAudits(need(actor), { datasetId: b.datasetId, modules: b.modules, layer2: b.layer2, faults: b.faults }) }; }));
on('GET', '/inbox', route(async (_r, { actor }) => (await wsvc()).inbox(need(actor))));
on('GET', '/runs/:id', route(async (_r, { actor, params }) => (await wsvc()).getRun(need(actor), params.id)));
on('POST', '/runs/:id/decision/options', route(async (req, { actor, params }) => { const b = await body<{ action: 'approve' | 'deny'; reason?: string }>(req); return (await wsvc()).beginDecision(need(actor), params.id, b.action, b.reason); }));
on('POST', '/runs/:id/decision', route(async (req, { actor, params }) => { const b = await body<{ action: 'approve' | 'deny'; reason?: string; passkey?: never }>(req); return (await wsvc()).decide(need(actor), params.id, b.action, b.reason, b.passkey); }));
on('GET', '/runs/:id/verify', route(async (_r, { actor, params }) => (await wsvc()).verifyRun(need(actor), params.id)));
on('GET', '/runs/:id/diff', route(async (_r, { actor, params }) => (await wsvc()).diff(need(actor), params.id)));
on('GET', '/runs/:id/evidence', route(async (_r, { actor, params }) => {
  const pkg = await (await wsvc()).evidencePackage(need(actor), params.id);
  return new Response(JSON.stringify(pkg, null, 2), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="aerotrace-evidence-${params.id}.json"` } });
}));
on('GET', '/runs/:id/report', route(async (_r, { actor, params }) => {
  const svc = await wsvc(); await svc.stepUp(need(actor), 'evidence.export');
  const r = await svc.getRun(need(actor), params.id); if (!r.result) throw new HttpError(409, 'The audit has not finished.');
  const appr = [`\n## Approval`, `- Policy: ${r.approval.policyName ?? 'none'}${r.approval.policyVersion ? ` v${r.approval.policyVersion}` : ''}`, `- Status: ${r.status}`,
    ...r.decisions.map(d => `- ${d.action === 'approve' ? 'Approved' : 'Denied'} at step "${d.stepName}" by ${d.userName}${d.onBehalfOf ? ` on behalf of ${d.onBehalfOf.name}` : ''} at ${d.at}${d.reason ? ` (${d.reason})` : ''} · ${d.signature.alg} ${d.signature.keyId} \`${d.signature.value.slice(0, 24)}…\`${d.passkey ? ` · signed with ${d.userName}'s passkey (user verified: ${d.passkey.userVerified ? 'yes' : 'no'})` : ''}`)];
  return new Response(toMarkdown({ ...r.result, decision: undefined }) + appr.join('\n') + '\n', { headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="aerotrace-${r.module}-${r.id}.md"` } });
}));

// ---------- program readiness & chaos drills ----------
on('GET', '/program', route(async (req, { actor }) => (await wsvc()).programOverview(need(actor), req.nextUrl.searchParams.get('dataset') || undefined)));
on('POST', '/chaos', route(async (req, { actor }) => { const b = await body<{ module: string; preset: never; datasetId?: string }>(req); return (await wsvc()).chaosDrill(need(actor), b); }));

// ---------- assistant & automation ----------
on('POST', '/assistant', route(async (req, { actor }) => { const b = await body<{ question: string; runId?: string; timezone?: string }>(req); return (await wsvc()).ask(need(actor), b.question, { runId: b.runId, timezone: b.timezone }); }));
on('POST', '/assistant/transcribe', route(async (req, { actor }) => {
  need(actor);
  const url = process.env.STT_URL; if (!url) throw new HttpError(404, 'Server speech-to-text is not configured; the browser will transcribe instead.');
  const form = await req.formData(); const audio = form.get('audio');
  if (!(audio instanceof Blob)) throw new HttpError(400, 'Send the recording as "audio".');
  if (audio.size > 10 * 1024 * 1024) throw new HttpError(413, 'Recordings are limited to 10 MB.');
  const out = new FormData(); out.set('file', audio, 'question.webm'); out.set('model', process.env.STT_MODEL || 'whisper-1'); out.set('response_format', 'json');
  const res = await fetch(url.replace(/\/$/, '') + '/audio/transcriptions', { method: 'POST', body: out, signal: AbortSignal.timeout(30000), headers: process.env.STT_API_KEY ? { authorization: `Bearer ${process.env.STT_API_KEY}` } : {} });
  if (!res.ok) throw new HttpError(502, `Speech-to-text failed (${res.status}).`);
  return { text: String(((await res.json()) as { text?: string }).text ?? '').trim() };
}));
on('GET', '/automation/suggestions', route(async (req, { actor }) => (await wsvc()).automationSuggestions(need(actor), req.nextUrl.searchParams.get('tz') || 'UTC')));
on('POST', '/automation/suggestions/dismiss', route(async (req, { actor }) => { const b = await body<{ key: string }>(req); await (await wsvc()).dismissSuggestion(need(actor), b.key); return { ok: true }; }));

// ---------- evidence sources ----------
on('GET', '/sources', route(async () => (await wsvc()).listSources()));
on('POST', '/sources', route(async (req, { actor }) => (await wsvc()).saveSource(need(actor), await body(req) as never)));
on('PUT', '/sources/:id', route(async (req, { actor, params }) => (await wsvc()).saveSource(need(actor), { ...(await body<Record<string, unknown>>(req)), id: params.id } as never)));
on('DELETE', '/sources/:id', route(async (_r, { actor, params }) => { await (await wsvc()).deleteSource(need(actor), params.id); return { ok: true }; }));
on('POST', '/sources/:id/sync', route(async (_r, { actor, params }) => (await wsvc()).requestSync(need(actor), params.id)));
on('POST', '/sources/:id/test', route(async (_r, { actor, params }) => (await wsvc()).testSource(need(actor), params.id)));

// ---------- schedules ----------
on('GET', '/schedules', route(async () => (await (await wsvc()).listSchedules()).map(s => ({ ...s, description: describeRecurrence(s.recurrence, s.timezone) }))));
on('POST', '/schedules', route(async (req, { actor }) => (await wsvc()).saveSchedule(need(actor), await body(req) as never)));
on('PUT', '/schedules/:id', route(async (req, { actor, params }) => (await wsvc()).saveSchedule(need(actor), { ...(await body<Record<string, unknown>>(req)), id: params.id } as never)));
on('DELETE', '/schedules/:id', route(async (_r, { actor, params }) => { await (await wsvc()).deleteSchedule(need(actor), params.id); return { ok: true }; }));
on('POST', '/schedules/:id/run', route(async (_r, { actor, params }) => ({ runIds: await (await wsvc()).runScheduleNow(need(actor), params.id) })));

// ---------- authority: policies, delegations ----------
on('GET', '/policies', route(async () => (await wsvc()).listPolicies()));
on('POST', '/policies', route(async (req, { actor }) => (await wsvc()).savePolicy(need(actor), await body(req) as never)));
on('PUT', '/policies/:id', route(async (req, { actor, params }) => (await wsvc()).savePolicy(need(actor), { ...(await body<Record<string, unknown>>(req)), id: params.id } as never)));
on('DELETE', '/policies/:id', route(async (_r, { actor, params }) => { await (await wsvc()).deletePolicy(need(actor), params.id); return { ok: true }; }));
on('POST', '/policies/simulate', route(async req => (await wsvc()).simulatePolicy(await body(req) as never)));
on('GET', '/delegations', route(async (_r, { actor }) => (await wsvc()).listDelegations(need(actor))));
on('POST', '/delegations', route(async (req, { actor }) => (await wsvc()).createDelegation(need(actor), await body(req) as never)));
on('DELETE', '/delegations/:id', route(async (_r, { actor, params }) => { await (await wsvc()).revokeDelegation(need(actor), params.id); return { ok: true }; }));

// ---------- access ----------
on('GET', '/users', route(async (_r, { actor }) => (await wsvc()).listUsers(need(actor))));
on('POST', '/users', route(async (req, { actor }) => (await wsvc()).createUser(need(actor), await body(req) as never)));
on('PATCH', '/users/:id', route(async (req, { actor, params }) => { await (await wsvc()).updateUser(need(actor), params.id, await body(req)); return { ok: true }; }));
on('GET', '/groups', route(async () => (await wsvc()).listGroups()));
on('POST', '/groups', route(async (req, { actor }) => { const b = await body<Record<string, never>>(req); return { id: await (await wsvc()).saveGroup(need(actor), b as never, b.memberIds) }; }));
on('PUT', '/groups/:id', route(async (req, { actor, params }) => { const b = await body<Record<string, never>>(req); return { id: await (await wsvc()).saveGroup(need(actor), { ...(b as object), id: params.id } as never, b.memberIds) }; }));
on('DELETE', '/groups/:id', route(async (_r, { actor, params }) => { await (await wsvc()).deleteGroup(need(actor), params.id); return { ok: true }; }));
on('GET', '/roles', route(async () => ({ roles: await (await wsvc()).listRoles(), permissions: ALL_PERMISSIONS.map(id => ({ id, label: PERMISSIONS[id] })) })));
on('POST', '/roles', route(async (req, { actor }) => { await (await wsvc()).saveRole(need(actor), await body(req) as never); return { ok: true }; }));
on('PUT', '/roles/:id', route(async (req, { actor, params }) => { await (await wsvc()).saveRole(need(actor), { ...(await body<Record<string, unknown>>(req)), id: params.id } as never); return { ok: true }; }));
on('DELETE', '/roles/:id', route(async (_r, { actor, params }) => { await (await wsvc()).deleteRole(need(actor), params.id); return { ok: true }; }));
on('GET', '/tokens', route(async (_r, { actor }) => (await wsvc()).listTokens(need(actor))));
on('POST', '/tokens', route(async (req, { actor }) => (await wsvc()).createToken(need(actor), await body(req) as never)));
on('DELETE', '/tokens/:id', route(async (_r, { actor, params }) => { await (await wsvc()).revokeToken(need(actor), params.id); return { ok: true }; }));

// ---------- settings & audit log ----------
on('GET', '/settings', route(async () => (await wsvc()).getSettings()));
on('PUT', '/settings', route(async (req, { actor }) => { await (await wsvc()).saveSettings(need(actor), await body(req) as never); return { ok: true }; }));
on('GET', '/audit-log', route(async (req, { actor }) => (await wsvc()).auditLog(need(actor), Number(req.nextUrl.searchParams.get('limit') || 200), Number(req.nextUrl.searchParams.get('before')) || undefined)));
on('GET', '/audit-log/verify', route(async (_r, { actor }) => (await wsvc()).verifyAuditLog(need(actor))));

export async function dispatch(req: NextRequest, segments: string[]) {
  const parts = segments.filter(Boolean);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const pat = r.path.split('/').filter(Boolean); if (pat.length !== parts.length) continue;
    const params: Record<string, string> = {}; let ok = true;
    for (let i = 0; i < pat.length; i++) { if (pat[i].startsWith(':')) params[pat[i].slice(1)] = decodeURIComponent(parts[i]); else if (pat[i] !== parts[i]) { ok = false; break; } }
    if (ok) {
      const t0 = Date.now(); const routeName = `/api${r.path}`;
      return telemetry.span(`${req.method} ${routeName}`, { 'http.request.method': req.method, 'http.route': routeName }, async set => {
        const res = await r.h(req, params); set({ 'http.response.status_code': res.status });
        telemetry.record('aerotrace.http.server.duration', Date.now() - t0, { route: routeName, method: req.method, status: res.status });
        return res;
      });
    }
  }
  const known = routes.some(r => { const pat = r.path.split('/').filter(Boolean); return pat.length === parts.length && pat.every((p, i) => p.startsWith(':') || p === parts[i]); });
  return NextResponse.json({ error: known ? 'Method not allowed.' : 'No such endpoint.' }, { status: known ? 405 : 404 });
}
