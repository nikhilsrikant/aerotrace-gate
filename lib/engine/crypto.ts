// SHA-256 and HMAC through Web Crypto, which exists in Node 18+ and every modern browser.
const enc = new TextEncoder();
const subtle = () => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('Web Crypto is not available in this runtime');
  return c.subtle;
};
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  return hex(await subtle().digest('SHA-256', enc.encode(text)));
}

const keyCache = new Map<string, CryptoKey>();
export async function hmac(secret: string, text: string): Promise<string> {
  let key = keyCache.get(secret);
  if (!key) {
    key = await subtle().importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  return hex(await subtle().sign('HMAC', key, enc.encode(text)));
}

// Stable JSON: keys sorted, so the same object always hashes the same way.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function randomId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(6);
  if (c?.getRandomValues) c.getRandomValues(bytes); else for (let i = 0; i < 6; i++) bytes[i] = Math.floor(Math.random() * 256);
  return prefix + '_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
