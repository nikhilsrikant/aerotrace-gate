#!/usr/bin/env node
// Verify an AeroTrace evidence package with nothing but Node and the package itself.
//   node scripts/verify-evidence.mjs aerotrace-evidence-run_xxx.json [public-key.jwk.json]
// Checks: the agent message hash chain, the report hash, every decision signature (Ed25519 or a cloud KMS ES256 key), and each approver's
// passkey signature (WebAuthn) over a challenge recomputed from the decision itself.
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';

const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
const sha = s => createHash('sha256').update(s).digest('hex');
const shaBuf = b => createHash('sha256').update(b).digest();
const b64u = s => Buffer.from(s, 'base64url');
// Minimal CBOR reader for COSE public keys.
function cbor(buf) {
  let i = 0;
  const len = info => info < 24 ? info : info === 24 ? buf[i++] : info === 25 ? (i += 2, buf.readUInt16BE(i - 2)) : info === 26 ? (i += 4, buf.readUInt32BE(i - 4)) : NaN;
  const item = () => { const b = buf[i++], t = b >> 5, n = len(b & 31);
    if (t === 0) return n; if (t === 1) return -1 - n; if (t === 2) { i += n; return buf.subarray(i - n, i); } if (t === 3) { i += n; return buf.subarray(i - n, i).toString(); }
    if (t === 4) return Array.from({ length: n }, item); if (t === 5) { const m = new Map(); for (let k = 0; k < n; k++) m.set(item(), item()); return m; } return null; };
  return item();
}
function coseKey(b) {
  const m = cbor(b), kty = m.get(1), alg = m.get(3), e = x => Buffer.from(x).toString('base64url');
  if (kty === 2 && alg === -7) return { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: e(m.get(-2)), y: e(m.get(-3)) }, format: 'jwk' }), hash: 'sha256' };
  if (kty === 1 && alg === -8) return { key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: e(m.get(-2)) }, format: 'jwk' }), hash: null };
  if (kty === 3 && alg === -257) return { key: createPublicKey({ key: { kty: 'RSA', n: e(m.get(-1)), e: e(m.get(-2)) }, format: 'jwk' }), hash: 'sha256' };
  throw new Error(`unsupported passkey key ${kty}/${alg}`);
}
function checkPasskey(d, runId) {
  const p = d.passkey;
  const want = shaBuf(canonical({ t: 'aerotrace-decision/1', run: runId, action: d.action, reportHash: d.reportHash, reason: d.reason ?? null, by: d.userId, nonce: p.nonce })).toString('base64url');
  const cd = JSON.parse(b64u(p.clientDataJSON).toString());
  if (cd.type !== 'webauthn.get' || cd.challenge !== want) return [false, 'challenge does not match this decision'];
  const auth = b64u(p.authenticatorData);
  if (!shaBuf(p.rpId).equals(auth.subarray(0, 32))) return [false, 'signed for a different site'];
  if (!(auth[32] & 1) || !(auth[32] & 4)) return [false, 'user not present or not verified'];
  const { key, hash } = coseKey(b64u(p.publicKey));
  const ok = verify(hash, Buffer.concat([auth, shaBuf(b64u(p.clientDataJSON))]), key, b64u(p.signature));
  return [ok, ok ? `signed on ${cd.origin}, user verified` : 'signature INVALID'];
}
const pkg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// Public keys: the one(s) you supply (recommended: fetched from /api/keys or your KMS yourself), else those in the package.
const supplied = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null;
const keyring = supplied ? (Array.isArray(supplied.keys) ? supplied.keys : [supplied]) : (pkg.signer.publicKeys?.length ? pkg.signer.publicKeys : [pkg.signer.publicKey].filter(Boolean));
const r = pkg.run, res = r.result; let ok = true;
const say = (pass, what) => { ok &&= pass; console.log(`${pass ? 'PASS' : 'FAIL'}  ${what}`); };

let prev = 'GENESIS', chain = true;
for (const m of res.messages) { const { hash, prevHash, sig, accepted, reason, ...body } = m; if (prevHash !== prev || sha(prev + canonical({ ...body, sig, accepted, reason })) !== hash) { chain = false; break; } prev = hash; }
say(chain, `agent message trail: ${res.messages.length} messages, hash chain ${chain ? 'intact' : 'broken'}`);
const body = { runId: res.id, module: res.module, baseline: res.baseline, verdict: res.verdict, reason: res.verdictReason,
  findings: res.findings.map(f => [f.id, f.status, f.severity, f.title]), criticalPath: res.criticalPath, chainTail: res.messages.at(-1)?.hash ?? 'GENESIS' };
const h = sha(canonical(body));
say(h === r.reportHash, `report hash ${h.slice(0, 16)}… ${h === r.reportHash ? 'matches' : 'does NOT match'} the signed hash`);
if (!keyring.length) { console.log('No public key in the package; signatures not checked (HS256 demo signer).'); }
else {
  if (supplied) console.log(`note: verifying with the ${keyring.length} key(s) you supplied`);
  for (const d of r.decisions) {
    const base = { run: r.id, step: d.stepId, action: d.action, by: d.userId, onBehalfOf: d.onBehalfOf?.id ?? null, at: d.at, reportHash: d.reportHash, reason: d.reason ?? null };
    const payload = Buffer.from(canonical(d.passkey ? { ...base, passkey: `${d.passkey.credentialId}:${d.passkey.challenge}:${d.passkey.publicKey}` } : base));
    const jwk = keyring.find(k => k.kid === d.signature.keyId) ?? (keyring.length === 1 && !keyring[0].kid ? keyring[0] : null);
    let good = false, how = `key ${d.signature.keyId} not in the keyring`;
    if (jwk) {
      const pub = createPublicKey({ key: jwk, format: 'jwk' }); const sig = Buffer.from(d.signature.value, 'base64');
      // Ed25519: the gate's built-in key. ES256: a cloud KMS/HSM key (raw r||s).
      good = d.signature.alg === 'Ed25519' ? verify(null, payload, pub, sig) : d.signature.alg === 'ES256' ? verify('sha256', payload, { key: pub, dsaEncoding: 'ieee-p1363' }, sig) : false;
      how = `${d.signature.alg} key ${d.signature.keyId}`;
    }
    say(good && d.reportHash === r.reportHash, `${d.action} by ${d.userName}${d.onBehalfOf ? ` for ${d.onBehalfOf.name}` : ''} at step "${d.stepName}" (${d.at}) · ${how}`);
  }
}
// Each approver's own passkey: independent of the gate's key, so a compromised server can't forge a decision.
for (const d of r.decisions) {
  if (!d.passkey) { console.log(`note  ${d.action} by ${d.userName} has no passkey signature (passkey signing was off)`); continue; }
  let res; try { res = checkPasskey(d, r.id); } catch (e) { res = [false, e.message]; }
  say(res[0], `${d.userName}'s passkey ${d.passkey.credentialId.slice(0, 10)}… on the ${d.action}: ${res[1]}`);
}
console.log(ok ? '\nEvidence verified.' : '\nVERIFICATION FAILED.'); process.exit(ok ? 0 : 1);
