// Server-only crypto: scrypt password hashes and Ed25519 decision signatures anyone can verify with the public key.
import { scrypt as _scrypt, randomBytes, timingSafeEqual, generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Hasher } from '../core/services';
import type { Signer } from '../core/signer';
import type { Repo } from '../core/repo';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 2 ** 15, r = 8, p = 1;
export const hasher: Hasher = {
  async hash(pw) { const salt = randomBytes(16); const k = await scrypt(pw, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }); return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${k.toString('base64')}`; },
  async verify(pw, stored) {
    const [alg, n, rr, pp, salt, key] = stored.split('$'); if (alg !== 'scrypt') return false;
    const k = await scrypt(pw, Buffer.from(salt, 'base64'), 32, { N: +n, r: +rr, p: +pp, maxmem: 64 * 1024 * 1024 });
    const want = Buffer.from(key, 'base64'); return want.length === k.length && timingSafeEqual(want, k);
  },
};

/** Key from SIGNING_PRIVATE_KEY (PEM) if set, else generated once at first start and kept in the database. */
export async function ed25519Signer(repo: Repo): Promise<Signer> {
  let pem = process.env.SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n') || null;
  if (!pem) {
    pem = await repo.getSecret('signing_key');
    if (!pem) { const { privateKey } = generateKeyPairSync('ed25519'); await repo.putSecret('signing_key', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()); pem = (await repo.getSecret('signing_key'))!; }
  }
  const priv = createPrivateKey(pem), pub = createPublicKey(priv);
  const spki = pub.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(spki).digest('hex').slice(0, 16);
  const jwk = { ...pub.export({ format: 'jwk' }), kid: keyId, use: 'sig', alg: 'EdDSA' };
  return {
    alg: 'Ed25519', keyId,
    async sign(text) { return { alg: 'Ed25519', keyId, value: sign(null, Buffer.from(text), priv).toString('base64') }; },
    async verify(text, sig) { return sig.alg === 'Ed25519' && sig.keyId === keyId && verify(null, Buffer.from(text), pub, Buffer.from(sig.value, 'base64')); },
    publicKey: () => jwk,
  };
}
