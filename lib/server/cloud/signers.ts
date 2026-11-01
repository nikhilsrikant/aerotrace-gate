// Decision signing keys held in a cloud KMS / HSM. The private key never leaves the vault; we send a SHA-256 digest
// and get back an ECDSA P-256 signature (ES256), stored as raw r||s (IEEE P1363) whatever the cloud returns.
// Every public key ever used is kept, so signatures made before a rotation or a move between clouds stay verifiable.
import { createHash, createPublicKey, verify as nodeVerify, type JsonWebKey } from 'node:crypto';
import type { Signer } from '../../core/signer';
import type { Signature } from '../../core/model';
import type { Repo } from '../../core/repo';
import { derToRaw } from '../../core/passkeyProof';
import { azureToken, gcpToken, cloudFetch } from './tokens';
import { ed25519Signer } from '../crypto';

type Jwk = JsonWebKey & { kid: string; alg: string; use: 'sig' };
const kidOf = (spkiDer: Uint8Array) => createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** Verify any signature we have ever issued, by key id, against the stored public key. */
export function verifyWithJwk(text: string, sig: Signature, jwk: Jwk): boolean {
  const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  if (sig.alg === 'Ed25519') return nodeVerify(null, Buffer.from(text), key, Buffer.from(sig.value, 'base64'));
  if (sig.alg === 'ES256') return nodeVerify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.value, 'base64'));
  return false;
}

/** Keeps the public half of every signing key in the database (not secret) and verifies against all of them. */
async function withHistory(repo: Repo, current: { alg: Signature['alg']; jwk: Jwk; sign(text: string): Promise<string> }): Promise<Signer> {
  const raw = await repo.getSecret('signing_public_keys');
  const keys: Jwk[] = raw ? JSON.parse(raw) : [];
  // A database that used the built-in Ed25519 key before moving to a KMS: keep that key verifiable.
  const legacy = await repo.getSecret('signing_key');
  if (legacy) { const pub = createPublicKey(legacy); const spki = pub.export({ type: 'spki', format: 'der' }); const kid = kidOf(spki); if (!keys.some(k => k.kid === kid)) keys.push({ ...(pub.export({ format: 'jwk' }) as JsonWebKey), kid, use: 'sig', alg: 'EdDSA' }); }
  if (!keys.some(k => k.kid === current.jwk.kid)) keys.push(current.jwk);
  if (keys.length !== (raw ? JSON.parse(raw).length : 0)) await repo.putSecret('signing_public_keys', JSON.stringify(keys));
  return {
    alg: current.alg, keyId: current.jwk.kid,
    async sign(text) { return { alg: current.alg, keyId: current.jwk.kid, value: await current.sign(text) }; },
    async verify(text, sig) { const k = keys.find(x => x.kid === sig.keyId); return !!k && verifyWithJwk(text, sig, k); },
    publicKey: () => current.jwk as unknown as Record<string, unknown>,
    publicKeys: () => keys as unknown as Record<string, unknown>[],
  };
}
const es256Jwk = (spkiDer: Uint8Array): Jwk => ({ ...(createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' }).export({ format: 'jwk' }) as JsonWebKey), kid: kidOf(spkiDer), use: 'sig', alg: 'ES256' });
const sha = (text: string) => createHash('sha256').update(text).digest();

export async function awsKmsSigner(repo: Repo, keyId: string, endpoint?: string): Promise<Signer> {
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import('@aws-sdk/client-kms');
  const c = new KMSClient(endpoint ? { endpoint } : {});
  const pk = await c.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (pk.KeySpec !== 'ECC_NIST_P256' || pk.KeyUsage !== 'SIGN_VERIFY') throw new Error(`KMS key ${keyId} must be ECC_NIST_P256 with SIGN_VERIFY (it is ${pk.KeySpec}/${pk.KeyUsage})`);
  return withHistory(repo, { alg: 'ES256', jwk: es256Jwk(pk.PublicKey!), async sign(text) {
    const out = await c.send(new SignCommand({ KeyId: keyId, Message: sha(text), MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }));
    return Buffer.from(derToRaw(out.Signature!)).toString('base64');
  } });
}

/** keyUrl: https://<vault>.vault.azure.net/keys/<name>[/<version>]. Versionless means "latest", pinned at start-up. */
export async function azureKeyVaultSigner(repo: Repo, keyUrl: string): Promise<Signer> {
  const token = () => azureToken('https://vault.azure.net/.default');
  const res = await cloudFetch('Azure Key Vault', `${keyUrl.replace(/\/$/, '')}?api-version=7.4`, { headers: { authorization: `Bearer ${await token()}` } });
  if (res.status === 404) throw new Error(`Key Vault key ${keyUrl} not found`);
  const k = ((await res.json()) as { key: { kid: string; kty: string; crv: string; x: string; y: string } }).key;
  if (!k.kty.startsWith('EC') || k.crv !== 'P-256') throw new Error(`Key Vault key ${keyUrl} must be an EC P-256 key (it is ${k.kty} ${k.crv})`);
  const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return withHistory(repo, { alg: 'ES256', jwk: es256Jwk(spki), async sign(text) {
    const r = await cloudFetch('Azure Key Vault', `${k.kid}/sign?api-version=7.4`, { method: 'POST', headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' }, body: JSON.stringify({ alg: 'ES256', value: b64u(sha(text)) }) });
    return Buffer.from(((await r.json()) as { value: string }).value, 'base64url').toString('base64');   // already raw r||s
  } });
}

/** keyVersion: projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/<n> */
export async function gcpKmsSigner(repo: Repo, keyVersion: string, endpoint = 'https://cloudkms.googleapis.com'): Promise<Signer> {
  const api = endpoint.replace(/\/$/, '');
  const auth = async () => ({ authorization: `Bearer ${await gcpToken()}` });
  const r = await cloudFetch('Cloud KMS', `${api}/v1/${keyVersion}/publicKey`, { headers: await auth() });
  if (r.status === 404) throw new Error(`Cloud KMS key ${keyVersion} not found`);
  const pk = (await r.json()) as { pem: string; algorithm: string };
  if (pk.algorithm !== 'EC_SIGN_P256_SHA256') throw new Error(`Cloud KMS key must use EC_SIGN_P256_SHA256 (it uses ${pk.algorithm})`);
  const spki = createPublicKey(pk.pem).export({ type: 'spki', format: 'der' });
  return withHistory(repo, { alg: 'ES256', jwk: es256Jwk(spki), async sign(text) {
    const s = await cloudFetch('Cloud KMS', `${api}/v1/${keyVersion}:asymmetricSign`, { method: 'POST', headers: { ...(await auth()), 'content-type': 'application/json' }, body: JSON.stringify({ digest: { sha256: sha(text).toString('base64') } }) });
    return Buffer.from(derToRaw(Buffer.from(((await s.json()) as { signature: string }).signature, 'base64'))).toString('base64');
  } });
}

/** SIGNER=local (default) | aws-kms | azure-kv | gcp-kms */
export async function signerFromEnv(repo: Repo, env: Record<string, string | undefined> = process.env): Promise<Signer> {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`SIGNER=${env.SIGNER} needs ${k}`); return v; };
  switch ((env.SIGNER || 'local').toLowerCase()) {
    case 'local': { const s = await ed25519Signer(repo); return withHistory(repo, { alg: 'Ed25519', jwk: s.publicKey() as unknown as Jwk, sign: async t => (await s.sign(t)).value }); }
    case 'aws-kms': return awsKmsSigner(repo, need('SIGNER_AWS_KMS_KEY_ID'), env.SIGNER_AWS_KMS_ENDPOINT);
    case 'azure-kv': return azureKeyVaultSigner(repo, need('SIGNER_AZURE_KEY_ID'));
    case 'gcp-kms': return gcpKmsSigner(repo, need('SIGNER_GCP_KMS_KEY'), env.GCP_KMS_ENDPOINT);
    default: throw new Error(`Unknown SIGNER "${env.SIGNER}". Use local, aws-kms, azure-kv or gcp-kms.`);
  }
}
