// A minimal X.509 builder for tests and the demo: a root CA and FIDO attestation certificates, like the ones a
// security-key vendor burns into its devices. Only what WebAuthn "packed" attestation needs. Not for production keys.
const subtle = () => globalThis.crypto.subtle;
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

function len(n: number) { if (n < 128) return new Uint8Array([n]); const b: number[] = []; while (n) { b.unshift(n & 255); n >>= 8; } return new Uint8Array([0x80 | b.length, ...b]); }
const tlv = (tag: number, v: Uint8Array) => cat(new Uint8Array([tag]), len(v.length), v);
const seq = (...x: Uint8Array[]) => tlv(0x30, cat(...x));
const set = (...x: Uint8Array[]) => tlv(0x31, cat(...x));
const int = (v: Uint8Array) => { let b = v; while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.slice(1); if (b[0] & 0x80) b = cat(new Uint8Array([0]), b); return tlv(0x02, b); };
const oid = (s: string) => { const p = s.split('.').map(Number); const out = [40 * p[0] + p[1]]; for (const n of p.slice(2)) { const st: number[] = []; let v = n; st.unshift(v & 127); v >>= 7; while (v) { st.unshift((v & 127) | 128); v >>= 7; } out.push(...st); } return tlv(0x06, new Uint8Array(out)); };
const printable = (s: string) => tlv(0x13, new TextEncoder().encode(s));
const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const octet = (v: Uint8Array) => tlv(0x04, v);
const bits = (v: Uint8Array, unused = 0) => tlv(0x03, cat(new Uint8Array([unused]), v));
const bool = (b: boolean) => tlv(0x01, new Uint8Array([b ? 0xff : 0]));
const explicit = (n: number, v: Uint8Array) => tlv(0xa0 + n, v);
const utcTime = (d: Date) => tlv(0x17, new TextEncoder().encode(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
function name(p: { C: string; O: string; OU: string; CN: string }) {
  return seq(set(seq(oid('2.5.4.6'), printable(p.C))), set(seq(oid('2.5.4.10'), utf8(p.O))), set(seq(oid('2.5.4.11'), utf8(p.OU))), set(seq(oid('2.5.4.3'), utf8(p.CN))));
}
function ext(id: string, critical: boolean, value: Uint8Array) { return critical ? seq(oid(id), bool(true), octet(value)) : seq(oid(id), octet(value)); }
function rawToDer(raw: Uint8Array) { return seq(int(raw.slice(0, 32)), int(raw.slice(32))); }
async function keyId(spki: Uint8Array) { return new Uint8Array(await subtle().digest('SHA-1', ab(spki))).slice(0, 20); }

async function issue(o: { subject: Parameters<typeof name>[0]; issuer: Parameters<typeof name>[0]; subjectKey: CryptoKeyPair; issuerKey: CryptoKeyPair; ca: boolean; aaguid?: Uint8Array; serial: number }) {
  const spki = new Uint8Array(await subtle().exportKey('spki', o.subjectKey.publicKey));
  const ispki = new Uint8Array(await subtle().exportKey('spki', o.issuerKey.publicKey));
  const now = Date.now();
  const exts = [
    ext('2.5.29.19', true, o.ca ? seq(bool(true)) : seq()),
    ...(o.ca ? [ext('2.5.29.15', true, bits(new Uint8Array([0x06]), 1))] : []),
    ext('2.5.29.14', false, octet(await keyId(spki))),
    ext('2.5.29.35', false, seq(tlv(0x80, await keyId(ispki)))),
    ...(o.aaguid ? [ext('1.3.6.1.4.1.45724.1.1.4', false, octet(o.aaguid))] : []),
  ];
  const tbs = seq(explicit(0, int(new Uint8Array([2]))), int(new Uint8Array([o.serial >> 8, o.serial & 255])), ECDSA_SHA256, name(o.issuer),
    seq(utcTime(new Date(now - 86400e3)), utcTime(new Date(now + 3650 * 86400e3))), name(o.subject), spki, explicit(3, seq(...exts)));
  const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, o.issuerKey.privateKey, ab(tbs)));
  return seq(tbs, ECDSA_SHA256, bits(rawToDer(sig)));
}
export const toPem = (der: Uint8Array) => { let s = ''; for (const b of der) s += String.fromCharCode(b); return `-----BEGIN CERTIFICATE-----\n${btoa(s).match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`; };
export const aaguidBytes = (s: string) => new Uint8Array(s.replace(/-/g, '').match(/../g)!.map(h => parseInt(h, 16)));

/** A vendor root CA that can issue attestation certificates for a given authenticator model (AAGUID). */
export async function makeAttestationCA(vendor: string) {
  const gen = () => subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
  const rootKey = await gen();
  const rootName = { C: 'US', O: vendor, OU: 'Attestation Root', CN: `${vendor} Attestation Root CA` };
  const rootDer = await issue({ subject: rootName, issuer: rootName, subjectKey: rootKey, issuerKey: rootKey, ca: true, serial: 1 });
  let serial = 100;
  return {
    rootPem: toPem(rootDer),
    async device(aaguid: string, model: string) {
      const key = await gen();
      const certDer = await issue({ subject: { C: 'US', O: vendor, OU: 'Authenticator Attestation', CN: `${model} Attestation` }, issuer: rootName, subjectKey: key, issuerKey: rootKey, ca: false, aaguid: aaguidBytes(aaguid), serial: serial++ });
      return { aaguid, key, certDer };
    },
  };
}
