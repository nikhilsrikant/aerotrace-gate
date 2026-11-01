// HTTP plumbing shared by every API route: who is calling, CSRF, errors, cookies.
import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ctx } from './context';
import type { Services } from '../core/services';
import { DEFAULT_WORKSPACE, wsOf } from '../core/model';
import { HttpError } from '../core/services';
import type { Actor } from '../core/model';
import { sha256, randomId } from '../engine';
import { log } from './log';

export const SESSION_COOKIE = 'aero_session';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const SECRET = process.env.SESSION_SECRET || '';
export const secureCookies = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : (process.env.PUBLIC_URL || '').startsWith('https://');

export function clientIp(req: NextRequest) { return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown'; }

// The services for the workspace this request acts in, available to every handler without passing it around.
const scope = new AsyncLocalStorage<{ svc: Services }>();
export async function wsvc(): Promise<Services> { return scope.getStore()?.svc ?? (await ctx()).svc.forWorkspace(DEFAULT_WORKSPACE); }

/**
 * Who is calling, and in which workspace. API tokens belong to one workspace. Browser sessions use the
 * x-aerotrace-workspace header or the session's chosen workspace, if the person belongs to it, else their first one.
 */
export async function resolveCaller(req: NextRequest): Promise<{ actor: Actor | null; svc: Services }> {
  const { svc: root, repo } = await ctx();
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const secret = auth.slice(7).trim(); const t = await repo.getTokenByHash(await sha256(secret));
    const svc = root.forWorkspace(wsOf(t)); return { actor: t ? await svc.actorFromToken(secret) : null, svc };
  }
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  const s = raw ? await repo.getSessionByHash(await sha256(raw)) : null;
  const u = s ? await repo.getUser(s.userId) : null;
  if (!s || !u || !u.active) return { actor: null, svc: root.forWorkspace(DEFAULT_WORKSPACE) };
  const mine = await root.workspacesFor(u);
  const wanted = req.headers.get('x-aerotrace-workspace') || s.workspaceId;
  const ws = wanted && mine.some(w => w.id === wanted) ? wanted : mine[0]?.id ?? DEFAULT_WORKSPACE;
  const svc = root.forWorkspace(ws);
  return { actor: await svc.actorForSession(s), svc };
}
export async function actorOf(req: NextRequest): Promise<Actor | null> { return (await resolveCaller(req)).actor; }

export async function startSession(res: NextResponse, userId: string, req: NextRequest, how: { method: 'password' | 'sso' | 'passkey' | 'invite'; passkeyId?: string } = { method: 'password' }) {
  const { repo } = await ctx();
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await repo.createSession({ id: randomId('ses'), tokenHash: await sha256(token), userId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600e3).toISOString(), ip: clientIp(req), userAgent: (req.headers.get('user-agent') || '').slice(0, 200),
    method: how.method, passkeyAt: how.method === 'passkey' ? now.toISOString() : null, passkeyId: how.passkeyId ?? null });
  res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/', maxAge: SESSION_HOURS * 3600 });
}

/** Short-lived signed cookie for the SSO round trip (state + PKCE verifier). */
export function sealed(value: object) {
  const body = Buffer.from(JSON.stringify({ ...value, exp: Date.now() + 10 * 60e3 })).toString('base64url');
  return `${body}.${createHmac('sha256', SECRET || 'unset').update(body).digest('base64url')}`;
}
export function unseal<T>(v: string | undefined): T | null {
  if (!v) return null; const [b, sig] = v.split('.'); if (!b || !sig) return null;
  const want = createHmac('sha256', SECRET || 'unset').update(b).digest('base64url');
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o as T : null;
}

type Handler = (req: NextRequest, p: { params: Record<string, string>; actor: Actor | null }) => Promise<Response | unknown>;
/** auth: must be signed in. gate: must also have unlocked the session with a passkey (when policy requires it). */
export interface RouteOpts { auth?: boolean; gate?: boolean }
export function route(fn: Handler, opts: RouteOpts = { auth: true }) {
  return async (req: NextRequest, params: Record<string, string>) => {
    const t0 = Date.now(); const rid = req.headers.get('x-request-id') || randomId('req');
    try {
      const caller = opts.auth === false ? await resolveCaller(req).catch(async () => ({ actor: null, svc: await wsvc() })) : await resolveCaller(req);
      const actor = caller.actor;
      if (opts.auth !== false && !actor) throw new HttpError(401, 'Sign in first.');
      // Cookie sessions must send the custom header; a cross-site form can't. Bearer tokens are exempt.
      if (actor?.via === 'session' && !['GET', 'HEAD'].includes(req.method) && req.headers.get('x-aerotrace-csrf') !== '1') throw new HttpError(403, 'Missing CSRF header.');
      if (actor && opts.auth !== false && opts.gate !== false) await caller.svc.assertAccess(actor);
      const out = await scope.run({ svc: caller.svc }, () => fn(req, { params, actor }));
      const res = out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
      res.headers.set('x-request-id', rid); res.headers.set('cache-control', 'no-store');
      if (Date.now() - t0 > 2000) log('info', 'slow request', { rid, path: req.nextUrl.pathname, ms: Date.now() - t0 });
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : 'Something went wrong on the server. The request id is in the response headers.';
      const code = e instanceof HttpError ? e.code : undefined;
      if (status >= 500) log('error', 'request failed', { rid, path: req.nextUrl.pathname, method: req.method, error: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 4).join(' | ') });
      return NextResponse.json(code ? { error: message, code } : { error: message }, { status, headers: { 'x-request-id': rid, 'cache-control': 'no-store' } });
    }
  };
}
export async function body<T = Record<string, unknown>>(req: NextRequest): Promise<T> { try { return (await req.json()) as T; } catch { throw new HttpError(400, 'Send a JSON body.'); } }
