// WebAuthn ceremonies (passkeys), built on SimpleWebAuthn. Used by the server and, unchanged, by the browser demo.
import {
  SettingsService, generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { Passkey, PublicUser } from './model';
import { b64u, cborDecode } from './passkeyProof';

export type { RegistrationResponseJSON, AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON };
/** Where passkeys are valid. id is the domain (no scheme, no port); origins are the exact URLs the browser reports. */
export interface RelyingParty { id: string; name: string; origins: string[] }

export async function registrationOptions(rp: RelyingParty, user: PublicUser, existing: Passkey[], attestation: 'none' | 'direct' = 'none') {
  return generateRegistrationOptions({
    rpName: rp.name, rpID: rp.id, userName: user.email, userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id), attestationType: attestation, timeout: 120000,
    excludeCredentials: existing.map(p => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
    // Discoverable so people can sign in with no username; user verification means fingerprint, face or PIN every time.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -8, -257],
  });
}

/** roots: PEM trust anchors for vendor attestation. With none, SimpleWebAuthn skips chain checks, so callers must not trust AAGUIDs then. */
export async function verifyRegistration(rp: RelyingParty, response: RegistrationResponseJSON, expectedChallenge: string, roots: string[] = []) {
  for (const identifier of ['packed', 'fido-u2f', 'tpm', 'android-key'] as const) SettingsService.setRootCertificates({ identifier, certificates: roots });
  const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) throw new Error('The passkey could not be verified.');
  const { credential, aaguid, credentialDeviceType, credentialBackedUp, fmt, attestationObject } = v.registrationInfo;
  const stmt = (cborDecode(attestationObject) as Map<string, unknown>).get('attStmt') as Map<string, unknown> | undefined;
  const fullAttestation = fmt !== 'none' && Array.isArray(stmt?.get('x5c')) && (stmt!.get('x5c') as unknown[]).length > 0;
  return { id: credential.id, publicKey: b64u.encode(credential.publicKey), counter: credential.counter, transports: (credential.transports ?? response.response.transports ?? []) as string[],
    aaguid, deviceType: credentialDeviceType, backedUp: credentialBackedUp, fmt, fullAttestation };
}

export async function authenticationOptions(rp: RelyingParty, allow: Passkey[] | null, challenge?: Uint8Array) {
  return generateAuthenticationOptions({
    rpID: rp.id, userVerification: 'required', timeout: 120000, challenge,
    allowCredentials: allow?.map(p => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
  });
}

export async function verifyAuthentication(rp: RelyingParty, response: AuthenticationResponseJSON, expectedChallenge: string, pk: Passkey) {
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: rp.origins, expectedRPID: rp.id, requireUserVerification: true,
    credential: { id: pk.id, publicKey: b64u.decode(pk.publicKey) as Uint8Array<ArrayBuffer>, counter: pk.counter, transports: pk.transports as AuthenticatorTransportFuture[] },
  });
  if (!v.verified) throw new Error('The passkey signature did not verify.');
  return { newCounter: v.authenticationInfo.newCounter, userVerified: v.authenticationInfo.userVerified, origin: v.authenticationInfo.origin, rpId: v.authenticationInfo.rpID };
}
