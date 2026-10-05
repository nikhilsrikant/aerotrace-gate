// Real passkey prompts for the deployed app (Touch ID, Windows Hello, Android, security keys).
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { ApiError } from './api';

const friendly = (e: unknown) => {
  const n = (e as { name?: string })?.name;
  if (n === 'NotAllowedError') return new ApiError('The passkey prompt was closed or timed out. Try again.', 400, 'passkey_cancelled');
  if (n === 'InvalidStateError') return new ApiError('This device already has a passkey for your account.', 400, 'passkey_exists');
  if (n === 'SecurityError') return new ApiError('Passkeys only work on the address your administrator configured (HTTPS or localhost).', 400, 'passkey_origin');
  return e instanceof Error ? e : new Error(String(e));
};
export function passkeysSupported() { return typeof window !== 'undefined' && browserSupportsWebAuthn(); }
export async function createPasskey(optionsJSON: PublicKeyCredentialCreationOptionsJSON) {
  if (!passkeysSupported()) throw new ApiError('This browser does not support passkeys. Use a current Chrome, Edge, Safari or Firefox.', 400, 'passkey_unsupported');
  try { return await startRegistration({ optionsJSON }); } catch (e) { throw friendly(e); }
}
export async function usePasskey(optionsJSON: PublicKeyCredentialRequestOptionsJSON) {
  if (!passkeysSupported()) throw new ApiError('This browser does not support passkeys. Use a current Chrome, Edge, Safari or Firefox.', 400, 'passkey_unsupported');
  try { return await startAuthentication({ optionsJSON }); } catch (e) { throw friendly(e); }
}
