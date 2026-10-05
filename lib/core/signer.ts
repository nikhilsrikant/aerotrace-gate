import { hmac, sha256 } from '../engine/crypto';
import type { Signature } from './model';

export interface Signer {
  alg: Signature['alg']; keyId: string;
  sign(text: string): Promise<Signature>;
  verify(text: string, sig: Signature): Promise<boolean>;
  publicKey(): Record<string, unknown> | null;
  /** Every public key this deployment has signed with (current first is not guaranteed); verifiers pick by keyId. */
  publicKeys?(): Record<string, unknown>[];
}

/** Shared-secret signer for the browser demo and tests. Production uses Ed25519 (lib/server/signer.ts). */
export async function hmacSigner(secret: string): Promise<Signer> {
  const keyId = (await sha256('hmac:' + secret)).slice(0, 16);
  return {
    alg: 'HS256', keyId,
    async sign(text) { return { alg: 'HS256', keyId, value: await hmac(secret, text) }; },
    async verify(text, sig) { return sig.alg === 'HS256' && sig.keyId === keyId && (await hmac(secret, text)) === sig.value; },
    publicKey: () => null,
  };
}
