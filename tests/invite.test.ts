// Invite links (no temporary passwords) and the approved-hardware allowlist backed by vendor attestation.
import assert from 'node:assert/strict';
import { MemRepo } from '../lib/core/memRepo';
import { Services, HttpError } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { sha256, randomId } from '../lib/engine';
import { SoftAuthenticator } from '../lib/testing/softAuthenticator';
import { makeAttestationCA } from '../lib/testing/x509';
import type { Actor, Session } from '../lib/core/model';

const code = async (p: Promise<unknown>, want: string | RegExp) => {
  try { await p; } catch (e) { const h = e as HttpError; if (typeof want === 'string') assert.equal(h.code, want, h.message); else assert.match(h.message, want); return h; }
  assert.fail(`expected failure ${want}`);
};

(async () => {
  let clock = new Date('2026-10-04T08:00:00Z');
  const repo = new MemRepo(); const ORIGIN = 'https://gate.honeywell.example';
  const svc = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true,
    now: () => clock, rp: s => ({ id: 'gate.honeywell.example', name: s.orgName, origins: [ORIGIN] }) });
  await seed(repo, svc, { demoUsers: true, syntheticDataset: false, hash: p => sha256(p) });
  const admin = await svc.actorFor((await repo.getUser('usr_sam'))!);
  const login = async (userId: string, method: Session['method']): Promise<Actor> => {
    const sess: Session = { id: randomId('ses'), tokenHash: randomId('h'), userId, createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 864e5).toISOString(), method };
    await repo.createSession(sess); return (await svc.actorForSession(sess))!;
  };
  const enroll = async (a: Actor, key: SoftAuthenticator) => { const o = await svc.beginPasskeyRegistration(a); return svc.finishPasskeyRegistration(a, o.challengeId, await key.create(o.options)); };

  // ---- invites ----
  // A new engineer, no password at all. Password and SSO sign-ins can't enrol under "invite only".
  const u = await svc.createUser(admin, { email: 'new.engineer@example.com', name: 'Nia Engineer', roleIds: ['role_engineer'], groupIds: [] });
  const inv = await svc.createInvite(admin, u.id);
  assert.match(inv.token, /^ati_[0-9a-f]{48}$/);
  const marcusInternal = await svc.actorFor((await repo.getUser('usr_marcus'))!);
  await code(svc.createInvite(marcusInternal, u.id), /permission/);            // engineers can't invite
  const user = await svc.redeemInvite(inv.token, '10.1.1.1');
  assert.equal(user.id, u.id);
  await code(svc.redeemInvite(inv.token, '10.1.1.1'), 'invite_invalid');       // one use only
  const nia = await login(u.id, 'invite');
  assert.equal((await svc.assurance(nia)).canEnroll, true);
  await enroll(nia, new SoftAuthenticator(ORIGIN));
  console.log('invite: redeemed once, passkey enrolled, reuse refused');

  // A newer link replaces an older one; links expire.
  const a1 = await svc.createInvite(admin, 'usr_lee'); const a2 = await svc.createInvite(admin, 'usr_lee');
  await code(svc.redeemInvite(a1.token), 'invite_invalid');
  clock = new Date(clock.getTime() + 73 * 3600e3);
  await code(svc.redeemInvite(a2.token), 'invite_invalid');
  // SSO sign-in may enrol under the default policy; under "invite only" it can't.
  const ssoLee = await login('usr_lee', 'sso');
  assert.equal((await svc.assurance(ssoLee)).canEnroll, true);
  const st = await svc.getSettings();
  await svc.saveSettings(admin, { ...st, passkeys: { ...st.passkeys!, enrollment: 'invite' } });
  await code(svc.beginPasskeyRegistration(await login('usr_lee', 'sso')), 'invite_required');
  await code(svc.beginPasskeyRegistration(await login('usr_lee', 'password')), 'invite_required');
  console.log('invite: replaced and expired links refused; "invite only" blocks SSO and password enrolment');

  // ---- approved hardware ----
  const vendor = await makeAttestationCA('Acme Keys');
  const rogue = await makeAttestationCA('Rogue Keys');
  const APPROVED = '6d44ba9b-f6ec-4e5a-8b3c-2f1d2e3a4b5c', OTHER = '0bb43545-fd2c-4185-87dd-feb0b2916ace';
  const good = new SoftAuthenticator(ORIGIN, { attestation: await vendor.device(APPROVED, 'Acme Key 5') });
  const wrongModel = new SoftAuthenticator(ORIGIN, { attestation: await vendor.device(OTHER, 'Acme Key Lite') });
  const forged = new SoftAuthenticator(ORIGIN, { attestation: await rogue.device(APPROVED, 'Acme Key 5 (forged)') });
  const platform = new SoftAuthenticator(ORIGIN);   // a laptop passkey: no attestation

  const st2 = await svc.getSettings();
  await svc.saveSettings(admin, { ...st2, passkeys: { ...st2.passkeys!, enrollment: 'invite_or_sso', allowedAuthenticators: [{ aaguid: APPROVED, name: 'Acme Key 5' }], attestationRoots: [] } });
  const lee = async () => { const r = await svc.createInvite(admin, 'usr_lee'); await svc.redeemInvite(r.token); return login('usr_lee', 'invite'); };
  // Without a pinned root nothing can be proven, so even the genuine key is refused.
  const o0 = await svc.beginPasskeyRegistration(await lee());
  assert.equal(o0.options.attestation, 'direct', 'asks the device to prove its model');
  await code((async () => { const a = await lee(); const o = await svc.beginPasskeyRegistration(a); return svc.finishPasskeyRegistration(a, o.challengeId, await good.create(o.options)); })(), /no attestation root/);

  await svc.saveSettings(admin, { ...st2, passkeys: { ...st2.passkeys!, enrollment: 'invite_or_sso', allowedAuthenticators: [{ aaguid: APPROVED, name: 'Acme Key 5' }], attestationRoots: [vendor.rootPem] } });
  await code(enroll(await lee(), platform), /did not prove its make and model/);
  await code(enroll(await lee(), wrongModel), /not on your organisation's approved list/);
  await code(enroll(await lee(), forged), /not accepted/);   // claims the approved model, but the certificate chains to the wrong root
  const ok = await enroll(await lee(), good);
  assert.equal(ok.attested, true); assert.equal(ok.model, 'Acme Key 5'); assert.equal(ok.name, 'Acme Key 5');
  console.log('allowlist: laptop passkey, wrong model and forged certificate refused; genuine approved key accepted');

  // Bad config is rejected up front.
  await code(svc.saveSettings(admin, { ...st2, passkeys: { ...st2.passkeys!, allowedAuthenticators: [{ aaguid: 'yubikey', name: 'x' }] } }), /not an AAGUID/);
  await code(svc.saveSettings(admin, { ...st2, passkeys: { ...st2.passkeys!, attestationRoots: ['not a cert'] } }), /PEM/);

  const acts = new Set((await svc.auditLog(admin, 500)).map(e => e.action));
  for (const x of ['user.invite', 'auth.invite_redeemed', 'auth.invite_failed', 'passkey.register_refused', 'passkey.register']) assert.ok(acts.has(x), `audit log has ${x}`);
  console.log('invite: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
