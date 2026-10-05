// What makes a passkey-signed decision checkable by anyone, later, without our server:
// the challenge is derived from the decision itself, and the stored WebAuthn assertion can be re-verified
// with the approver's public key. Plain WebCrypto, so it runs on the server, in the browser and in tests.
import { canonical } from '../engine';
import type { PasskeyProof } from './model';

const subtle = () => globalThis.crypto.subtle;
export const b64u = {
  encode(b: Uint8Array): string { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  decode(s: string): Uint8Array { const p = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(p + '==='.slice((p.length + 3) % 4)); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; },
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function sha256(b: Uint8Array) { return new Uint8Array(await subtle().digest('SHA-256', ab(b))); }

/** The exact thing an approver's device signs: who decides what about which report. */
export interface DecisionIntent { run: string; action: 'approve' | 'deny'; reportHash: string; reason: string | null; by: string; nonce: string }
export async function decisionChallenge(i: DecisionIntent): Promise<string> {
  return b64u.encode(await sha256(utf8(canonical({ t: 'aerotrace-decision/1', run: i.run, action: i.action, reportHash: i.reportHash, reason: i.reason, by: i.by, nonce: i.nonce }))));
}

// ---- minimal CBOR decoding, enough for COSE public keys ----
export function cborDecode(buf: Uint8Array): unknown {
  let i = 0;
  const len = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return buf[i++];
    if (info === 25) { const v = (buf[i] << 8) | buf[i + 1]; i += 2; return v; }
    if (info === 26) { const v = ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3]; i += 4; return v; }
    throw new Error('CBOR length too large');
  };
  const item = (): unknown => {
    const b = buf[i++]; const major = b >> 5, info = b & 31;
    switch (major) {
      case 0: return len(info);
      case 1: return -1 - len(info);
      case 2: { const n = len(info); const v = buf.slice(i, i + n); i += n; return v; }
      case 3: { const n = len(info); const v = new TextDecoder().decode(buf.slice(i, i + n)); i += n; return v; }
      case 4: { const n = len(info); return Array.from({ length: n }, item); }
      case 5: { const n = len(info); const m = new Map<unknown, unknown>(); for (let k = 0; k < n; k++) { const key = item(); m.set(key, item()); } return m; }
      case 7: return info === 20 ? false : info === 21 ? true : null;
      default: throw new Error(`CBOR major type ${major} not supported`);
    }
  };
  return item();
}

/** COSE key → JWK plus the WebCrypto algorithm to verify with. Covers ES256, EdDSA and RS256, which is what passkeys use. */
export function coseToJwk(cose: Uint8Array): { jwk: JsonWebKey; verify: AlgorithmIdentifier | EcdsaParams | RsaPssParams; import: AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams; der: boolean } {
  const m = cborDecode(cose) as Map<number, unknown>;
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7) return { jwk: { kty: 'EC', crv: 'P-256', x: b64u.encode(m.get(-2) as Uint8Array), y: b64u.encode(m.get(-3) as Uint8Array) }, import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' }, der: true };
  if (kty === 1 && alg === -8) return { jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u.encode(m.get(-2) as Uint8Array) }, import: { name: 'Ed25519' }, verify: { name: 'Ed25519' }, der: false };
  if (kty === 3 && alg === -257) return { jwk: { kty: 'RSA', n: b64u.encode(m.get(-1) as Uint8Array), e: b64u.encode(m.get(-2) as Uint8Array) }, import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verify: { name: 'RSASSA-PKCS1-v1_5' }, der: false };
  throw new Error(`Passkey key type ${String(kty)}/${String(alg)} is not supported for offline checks`);
}

/** ECDSA signatures in WebAuthn are DER; WebCrypto wants raw r||s. */
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let i = 2; if (der[1] & 0x80) i += der[1] & 0x7f;
  const read = () => { if (der[i++] !== 0x02) throw new Error('bad DER'); const n = der[i++]; let v = der.slice(i, i + n); i += n; while (v.length > size && v[0] === 0) v = v.slice(1); const o = new Uint8Array(size); o.set(v, size - v.length); return o; };
  return concat(read(), read());
}

export interface ProofCheck { ok: boolean; detail: string }
/** Re-verify a stored decision signature: right challenge, right site, person present and verified, valid signature. */
export async function verifyPasskeyProof(p: PasskeyProof, expectedChallenge: string): Promise<ProofCheck> {
  try {
    const cd = JSON.parse(new TextDecoder().decode(b64u.decode(p.clientDataJSON))) as { type: string; challenge: string; origin: string };
    if (cd.type !== 'webauthn.get') return { ok: false, detail: 'not an assertion' };
    if (cd.challenge !== expectedChallenge || p.challenge !== expectedChallenge) return { ok: false, detail: 'challenge does not match this decision' };
    if (cd.origin !== p.origin) return { ok: false, detail: 'origin mismatch' };
    const auth = b64u.decode(p.authenticatorData);
    const rpHash = await sha256(utf8(p.rpId));
    if (!rpHash.every((v, k) => v === auth[k])) return { ok: false, detail: 'signed for a different site' };
    const flags = auth[32]; if (!(flags & 0x01)) return { ok: false, detail: 'user presence flag missing' };
    if (!(flags & 0x04)) return { ok: false, detail: 'user was not verified (no biometric or PIN)' };
    const k = coseToJwk(b64u.decode(p.publicKey));
    const key = await subtle().importKey('jwk', k.jwk, k.import, false, ['verify']);
    const signed = concat(auth, await sha256(b64u.decode(p.clientDataJSON)));
    const sig = b64u.decode(p.signature);
    const ok = await subtle().verify(k.verify, key, ab(k.der ? derToRaw(sig) : sig), ab(signed));
    return ok ? { ok: true, detail: `passkey ${p.credentialId.slice(0, 10)}… signed this decision (user verified)` } : { ok: false, detail: 'passkey signature INVALID' };
  } catch (e) { return { ok: false, detail: `could not check: ${(e as Error).message}` }; }
}
