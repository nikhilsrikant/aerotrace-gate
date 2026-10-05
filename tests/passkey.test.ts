// Passkeys: enrolment, passwordless sign-in, the data gate, step-up, passkey-signed decisions, offline proof, admin reset.
import assert from 'node:assert/strict';
import { MemRepo } from '../lib/core/memRepo';
import { Services, HttpError, decisionPayload } from '../lib/core/services';
import { hmacSigner } from '../lib/core/signer';
import { seed } from '../lib/core/seed';
import { sha256, randomId } from '../lib/engine';
import { SoftAuthenticator } from '../lib/testing/softAuthenticator';
import { verifyPasskeyProof, decisionChallenge } from '../lib/core/passkeyProof';
import type { Actor, Session } from '../lib/core/model';

const code = async (p: Promise<unknown>, want: string | RegExp) => {
  try { await p; } catch (e) { const h = e as HttpError; if (typeof want === 'string') assert.equal(h.code, want, `${h.message}`); else assert.match(h.message, want); return h; }
  assert.fail(`expected failure ${want}`);
};

(async () => {
  let clock = new Date('2026-10-03T15:00:00Z');
  const repo = new MemRepo();
  const ORIGIN = 'https://gate.honeywell.example';
  const svc = new Services({ repo, signer: await hmacSigner('t'), hasher: { hash: p => sha256(p), verify: async (p, h) => (await sha256(p)) === h }, inline: true,
    now: () => clock, rp: s => ({ id: 'gate.honeywell.example', name: s.orgName, origins: [ORIGIN] }) });
  const s = await seed(repo, svc, { demoUsers: true, syntheticDataset: true, hash: p => sha256(p) });
  const ds = s.datasetId!;

  // A "browser session" for a user, as the HTTP layer would create after a password sign-in.
  const login = async (userId: string, method: Session['method'] = 'password'): Promise<Actor> => {
    const sess: Session = { id: randomId('ses'), tokenHash: randomId('h'), userId, createdAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + 864e5).toISOString(), method };
    await repo.createSession(sess); return (await svc.actorForSession(sess))!;
  };
  const refresh = async (a: Actor) => svc.actorForSession((await repo.sessions.get(a.session!.id))!) as Promise<Actor>;

  // Default policy: passkeys required, decisions signed.
  const pol = await svc.passkeyPolicy();
  assert.equal(pol.required, true); assert.equal(pol.signDecisions, true);

  // 1. Priya signs in with her password: data is locked until she enrolls.
  // A password sign-in can't enrol the first passkey (default policy): Priya gets an invite link instead.
  const pw = await login('usr_priya');
  await code(svc.beginPasskeyRegistration(pw), 'invite_required');
  const admin = await svc.actorFor((await repo.getUser('usr_sam'))!);
  await svc.redeemInvite((await svc.createInvite(admin, 'usr_priya')).token);
  let priya = await login('usr_priya', 'invite');
  await code(svc.assertAccess(priya), 'passkey_enroll');
  const priyaKey = new SoftAuthenticator(ORIGIN);
  const reg = await svc.beginPasskeyRegistration(priya);
  assert.equal(reg.options.authenticatorSelection?.userVerification, 'required');
  // A response for someone else's challenge is refused.
  const other = await login('usr_marcus', 'invite');
  await code(svc.finishPasskeyRegistration(other, reg.challengeId, await new SoftAuthenticator(ORIGIN).create(reg.options)), 'challenge_mismatch');
  const reg2 = await svc.beginPasskeyRegistration(priya);
  const pk = await svc.finishPasskeyRegistration(priya, reg2.challengeId, await priyaKey.create(reg2.options), 'Work laptop');
  assert.equal(pk.name, 'Work laptop'); assert.ok(!('publicKey' in pk));
  priya = await refresh(priya);
  await svc.assertAccess(priya);   // enrolment with user verification unlocks the session
  console.log('enrolled:', pk.name, pk.deviceType, 'backedUp', pk.backedUp);

  // A replayed challenge is refused.
  await code(svc.finishPasskeyRegistration(priya, reg2.challengeId, await new SoftAuthenticator(ORIGIN).create(reg2.options)), 'challenge_expired');
  // A second passkey needs a fresh passkey check; after 6 minutes it isn't fresh.
  clock = new Date(clock.getTime() + 6 * 60e3);
  await code(svc.beginPasskeyRegistration(priya), 'step_up_required');

  // 2. Next day: passwordless sign-in with the passkey.
  clock = new Date(clock.getTime() + 864e5);
  const lo = await svc.beginPasskeyLogin();
  assert.equal(lo.options.allowCredentials, undefined);
  const res = await svc.finishPasskeyLogin(lo.challengeId, await priyaKey.get(lo.options), '10.0.0.5');
  assert.equal(res.user.id, 'usr_priya');
  // A look-alike site can't use the passkey: the browser reports its real origin, and the server refuses it.
  const lo2 = await svc.beginPasskeyLogin();
  await code(svc.finishPasskeyLogin(lo2.challengeId, await priyaKey.clone('https://gate.honeywe11.example').get(lo2.options), '1.2.3.4'), /not accepted/);
  // A touch without fingerprint, face or PIN (no user verification) is refused.
  priya = await login('usr_priya');
  const r3 = await svc.beginPasskeyVerify(priya);
  await code(svc.finishPasskeyVerify(priya, r3.challengeId, await priyaKey.clone(ORIGIN, { userVerified: false }).get(r3.options)), /not accepted/);
  console.log('passwordless sign-in ok; phishing origin refused');

  // 3. Password session for someone who has a passkey: verify to unlock.
  priya = await login('usr_priya');
  await code(svc.assertAccess(priya), 'passkey_required');
  const v = await svc.beginPasskeyVerify(priya);
  await svc.finishPasskeyVerify(priya, v.challengeId, await priyaKey.get(v.options));
  priya = await refresh(priya); await svc.assertAccess(priya);

  // 4. A decision must be signed by the approver's passkey over this exact report.
  const marcusA = await svc.actorFor((await repo.getUser('usr_marcus'))!);
  const [baro] = await svc.startAudits(marcusA, { datasetId: ds, modules: ['BARO-IN'], layer2: 'heuristic' });
  await code(svc.decide(priya, baro, 'approve'), 'decision_passkey_required');
  const d1 = await svc.beginDecision(priya, baro, 'approve');
  assert.equal(d1.signing.action, 'approve');
  // Answering the approve challenge but submitting a deny is refused.
  const deny = await svc.beginDecision(priya, baro, 'approve');
  await code(svc.decide(priya, baro, 'deny', 'x', { challengeId: deny.challengeId, response: await priyaKey.get(deny.options) }), 'challenge_mismatch');
  const run = await svc.decide(priya, baro, 'approve', undefined, { challengeId: d1.challengeId, response: await priyaKey.get(d1.options) });
  const dec = run.decisions[0];
  assert.ok(dec.passkey && dec.passkey.userVerified);
  const ver = await svc.verifyRun(priya, baro);
  assert.ok(ver.ok, JSON.stringify(ver.checks));
  assert.ok(ver.checks.some(c => /passkey/.test(c.name) && c.ok));
  console.log('decision signed by passkey:', ver.checks.map(c => `${c.ok ? 'ok' : 'FAIL'} ${c.name}`).join(' | '));
  // Offline: recompute the challenge from the decision; tampering with the report hash breaks it.
  const want = await decisionChallenge({ run: baro, action: 'approve', reportHash: dec.reportHash, reason: null, by: 'usr_priya', nonce: dec.passkey!.nonce });
  assert.ok((await verifyPasskeyProof(dec.passkey!, want)).ok);
  const forged = await decisionChallenge({ run: baro, action: 'approve', reportHash: 'f'.repeat(64), reason: null, by: 'usr_priya', nonce: dec.passkey!.nonce });
  assert.equal((await verifyPasskeyProof(dec.passkey!, forged)).ok, false);
  assert.equal((await verifyPasskeyProof({ ...dec.passkey!, signature: dec.passkey!.signature.slice(0, -4) + 'AAAA' }, want)).ok, false);
  // The gate's own signature covers the passkey proof too.
  assert.ok(decisionPayload({ run: baro, step: dec.stepId, action: 'approve', by: 'usr_priya', onBehalfOf: null, at: dec.at, reportHash: dec.reportHash, reason: null, passkey: dec.passkey }).includes(dec.passkey!.credentialId));

  // 5. Step-up: exporting evidence needs a check in the last 5 minutes.
  clock = new Date(clock.getTime() + 10 * 60e3);
  priya = await refresh(priya);
  await code(svc.evidencePackage(priya, baro), 'step_up_required');
  const v2 = await svc.beginPasskeyVerify(priya); await svc.finishPasskeyVerify(priya, v2.challengeId, await priyaKey.get(v2.options));
  priya = await refresh(priya);
  const pkg = await svc.evidencePackage(priya, baro);
  assert.ok(pkg.verification.ok);

  // 6. API tokens: can start audits, cannot sign decisions or pass step-up.
  const tok = await svc.createToken(await svc.actorFor((await repo.getUser('usr_priya'))!), { name: 'CI' });
  const ta = (await svc.actorFromToken(tok.token))!;
  await svc.assertAccess(ta);
  await code(svc.decide(ta, baro, 'approve'), 'passkey_person_only');
  await code(svc.evidencePackage(ta, baro), 'passkey_person_only');

  // 7. Admin: Sam enrolls, then resets Dana's passkeys (lost phone). Dana is signed out everywhere.
  let sam = await login('usr_sam', 'invite');
  const samKey = new SoftAuthenticator(ORIGIN);
  const sr = await svc.beginPasskeyRegistration(sam); await svc.finishPasskeyRegistration(sam, sr.challengeId, await samKey.create(sr.options), 'YubiKey');
  sam = await refresh(sam);
  let dana = await login('usr_dana', 'invite'); const danaKey = new SoftAuthenticator(ORIGIN);
  const dr = await svc.beginPasskeyRegistration(dana); await svc.finishPasskeyRegistration(dana, dr.challengeId, await danaKey.create(dr.options));
  assert.equal((await svc.listUsers(sam)).find(u => u.id === 'usr_dana')?.passkeys, 1);
  await code(svc.resetPasskeys(sam, 'usr_sam'), /Security page/);
  const out = await svc.resetPasskeys(sam, 'usr_dana');
  assert.equal(out.removed, 1); assert.equal(repo.sessions.has(dana.session!.id), false);
  assert.ok(out.invite.token.startsWith('ati_'), 'a reset comes with a fresh invite link');
  const marcusS = await login('usr_marcus');
  await code(svc.resetPasskeys(marcusS, 'usr_dana'), /permission/);

  // 8. Removing your only passkey is refused while passkeys are required.
  const only = (await svc.myPasskeys(sam))[0];
  await code(svc.removePasskey(sam, only.id), /only passkey/);

  // 9. Policy is data: an admin can relax step-up for evidence; turning passkeys off is audit-logged.
  const settings = await svc.getSettings();
  await svc.saveSettings(sam, { ...settings, passkeys: { ...settings.passkeys!, stepUpFor: ['policy.change'], stepUpMinutes: 15 } });
  clock = new Date(clock.getTime() + 60 * 60e3);
  priya = await refresh(priya);
  await svc.evidencePackage(priya, baro);   // no longer needs a fresh check
  const log = await svc.auditLog(sam, 500);
  const acts = new Set(log.map(e => e.action));
  for (const a of ['passkey.register', 'auth.login', 'auth.passkey_verified', 'decision.approve', 'passkey.reset', 'settings.passkey_policy', 'auth.login_failed']) assert.ok(acts.has(a), `audit log has ${a}`);
  assert.ok((await svc.verifyAuditLog(sam)).ok);
  console.log('passkey: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
