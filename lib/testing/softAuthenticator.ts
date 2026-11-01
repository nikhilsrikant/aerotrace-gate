// A software passkey authenticator: produces real WebAuthn responses (ES256, "none" attestation) that the
// production verifier accepts. Used by the tests and by the browser demo, where a real device prompt isn't available.
// It is NOT a security device: keys live in memory. Real deployments use Touch ID, Windows Hello, Android or a security key.
import type { RegistrationResponseJSON, AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '../core/webauthn';
import { b64u } from '../core/passkeyProof';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const sha = async (b: Uint8Array) => new Uint8Array(await subtle().digest('SHA-256', ab(b)));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) => n < 24 ? new Uint8Array([(major << 5) | n]) : n < 256 ? new Uint8Array([(major << 5) | 24, n])
    : n < 65536 ? new Uint8Array([(major << 5) | 25, n >> 8, n & 255]) : cat(new Uint8Array([(major << 5) | 26]), u32(n));
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = enc.encode(v); return cat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (Array.isArray(v)) return cat(head(4, v.length), ...v.map(cbor));
  if (v instanceof Map) return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  if (v && typeof v === 'object') { const e = Object.entries(v); return cat(head(5, e.length), ...e.flatMap(([k, x]) => [cbor(k), cbor(x)])); }
  throw new Error('cbor: unsupported value');
}
function rawToDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

interface Cred { id: string; keys: CryptoKeyPair; rpId: string; userHandle: string; userName: string; counter: number }

export class SoftAuthenticator {
  private creds: Cred[] = [];
  /** origin is what the "browser" reports, e.g. https://gate.example.com */
  /** attestation: a vendor certificate for this device model, returned when the site asks for direct attestation. */
  constructor(public origin: string, public opts: { userVerified?: boolean; attestation?: { aaguid: string; key: CryptoKeyPair; certDer: Uint8Array } } = {}) {}

  /** Same keys, different browser origin or behaviour: for testing phishing sites and missing user verification. */
  clone(origin: string, opts: SoftAuthenticator['opts'] = this.opts) { const c = new SoftAuthenticator(origin, opts); c.creds = this.creds; return c; }
  list(rpId?: string) { return this.creds.filter(c => !rpId || c.rpId === rpId).map(c => ({ id: c.id, userName: c.userName, userHandle: c.userHandle })); }

  async create(o: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
    const rpId = o.rp.id ?? new URL(this.origin).hostname;
    if (o.excludeCredentials?.some(x => this.creds.find(c => c.id === x.id))) throw new Error('InvalidStateError: this authenticator is already registered');
    const keys = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const raw = new Uint8Array(await subtle().exportKey('raw', keys.publicKey));
    const idBytes = globalThis.crypto.getRandomValues(new Uint8Array(16)); const id = b64u.encode(idBytes);
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33, 65)]]));
    const flags = 0x01 | (this.opts.userVerified === false ? 0 : 0x04) | 0x08 | 0x10 | 0x40; // UP, UV, backup eligible, backed up, attested data
    const att = this.opts.attestation; const direct = !!att && (o.attestation === 'direct' || o.attestation === 'enterprise');
    const aaguid = direct ? new Uint8Array(att!.aaguid.replace(/-/g, '').match(/../g)!.map(h => parseInt(h, 16))) : new Uint8Array(16);
    const authData = cat(await sha(enc.encode(rpId)), new Uint8Array([flags]), u32(0), aaguid, new Uint8Array([0, idBytes.length]), idBytes, cose);
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge: o.challenge, origin: this.origin, crossOrigin: false }));
    let attObj: Uint8Array;
    if (direct) {
      const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, att!.key.privateKey, ab(cat(authData, await sha(clientDataJSON)))));
      attObj = cbor({ fmt: 'packed', attStmt: { alg: -7, sig: rawToDer(sig), x5c: [att!.certDer] }, authData });
    } else attObj = cbor({ fmt: 'none', attStmt: {}, authData });
    this.creds.push({ id, keys, rpId, userHandle: o.user.id, userName: o.user.name, counter: 0 });
    return { id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u.encode(clientDataJSON), attestationObject: b64u.encode(attObj), transports: direct ? ['usb', 'nfc'] : ['internal', 'hybrid'] } };
  }

  /** pick: choose which stored credential answers a discoverable (username-less) request. */
  async get(o: PublicKeyCredentialRequestOptionsJSON, pick?: (c: { id: string; userName: string }) => boolean): Promise<AuthenticationResponseJSON> {
    const rpId = o.rpId ?? new URL(this.origin).hostname;
    const allowed = o.allowCredentials?.length ? this.creds.filter(c => o.allowCredentials!.some(x => x.id === c.id)) : this.creds.filter(c => c.rpId === rpId);
    const c = (pick ? allowed.find(pick) : allowed[0]);
    if (!c) throw new Error('NotAllowedError: no matching passkey on this authenticator');
    c.counter += 1;
    const flags = 0x01 | (this.opts.userVerified === false ? 0 : 0x04) | 0x08 | 0x10;
    const authData = cat(await sha(enc.encode(c.rpId)), new Uint8Array([flags]), u32(c.counter));
    const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin: this.origin, crossOrigin: false }));
    const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, c.keys.privateKey, ab(cat(authData, await sha(clientDataJSON)))));
    return { id: c.id, rawId: c.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64u.encode(clientDataJSON), authenticatorData: b64u.encode(authData), signature: b64u.encode(rawToDer(sig)), userHandle: c.userHandle } };
  }
}
