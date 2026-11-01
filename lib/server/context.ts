// One Services instance per process, wired to Postgres, Ed25519, scrypt, the LLM and webhooks.
import { PgRepo } from './pgRepo';
import { Services } from '../core/services';
import { hasher } from './crypto';
import { signerFromEnv } from './cloud/signers';
import { llmFor } from './llm';
import { notify } from './notify';
import { log } from './log';
import { sourceRuntime } from './connectors';

import type { Settings } from '../core/model';
import type { RelyingParty } from '../core/webauthn';

/** Passkeys are bound to a domain. RP_ID defaults to PUBLIC_URL's host; RP_ORIGINS lists every URL people open the app on. */
export function relyingParty(s: Settings): RelyingParty {
  const pub = new URL(process.env.PUBLIC_URL || 'http://localhost:3000');
  return { id: process.env.RP_ID || pub.hostname, name: process.env.RP_NAME || s.orgName,
    origins: (process.env.RP_ORIGINS || pub.origin).split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean) };
}

type Ctx = { repo: PgRepo; svc: Services };
const g = globalThis as unknown as { __aeroCtx?: Promise<Ctx> };
export function ctx(): Promise<Ctx> {
  if (!g.__aeroCtx) g.__aeroCtx = (async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    const repo = PgRepo.fromEnv();
    const svc = new Services({ repo, signer: await signerFromEnv(repo), hasher, llm: llmFor, notify, log, rp: relyingParty, sources: sourceRuntime });
    return { repo, svc };
  })().catch(e => { g.__aeroCtx = undefined; throw e; });
  return g.__aeroCtx;
}
