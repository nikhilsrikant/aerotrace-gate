// Outbound HTTP for evidence connectors. Every request a connector makes goes through here, because the URLs come from
// workspace administrators and the process holds cloud credentials. So:
//   - https only (plain http only for hosts named in CONNECTOR_ALLOWED_HOSTS, for on-prem servers and tests);
//   - the address is checked at connect time (no DNS-rebinding window): loopback, private, link-local and cloud metadata
//     addresses are refused unless the host is in CONNECTOR_ALLOWED_HOSTS; metadata addresses are refused always;
//   - redirects are followed by hand, re-checked, and the Authorization header is dropped when the host changes;
//   - responses are size-capped and time-limited.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

export class ConnectorError extends Error { constructor(msg: string, public status?: number) { super(msg); } }

const METADATA_IPS = new Set(['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', '100.100.100.200']);
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata', 'metadata.azure.com', 'instance-data', 'instance-data.ec2.internal']);

function v4Blocked(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
/** Why an address may not be contacted, or null when it may. */
export function addressProblem(ip: string, allowed: boolean): string | null {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (METADATA_IPS.has(v)) return 'cloud metadata endpoint';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); if (mapped) return addressProblem(mapped[1], allowed);
  if (allowed) return null;
  if (net.isIPv4(v)) return v4Blocked(v) ? 'private, loopback or link-local address' : null;
  if (v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return 'private, loopback or link-local address';
  return null;
}
export const allowedHosts = () => new Set((process.env.CONNECTOR_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

/** Checks a URL an administrator typed, before anything is stored or fetched. */
export function checkUrl(raw: string): URL {
  let u: URL; try { u = new URL(raw); } catch { throw new ConnectorError(`"${raw}" is not a URL.`); }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); const allowed = allowedHosts().has(host);
  if (u.username || u.password) throw new ConnectorError('Put credentials in a secret reference, not in the URL.');
  if (METADATA_HOSTS.has(host) || METADATA_IPS.has(host)) throw new ConnectorError(`${host} is a cloud metadata endpoint.`);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowed)) throw new ConnectorError(`${u.origin}: connectors only use https.`);
  if (net.isIP(host)) { const p = addressProblem(host, allowed); if (p) throw new ConnectorError(`${host} is a ${p}. Add it to CONNECTOR_ALLOWED_HOSTS if it is really your server.`); }
  return u;
}

const guardedLookup = (allowed: boolean): LookupFunction => (host, opts, cb) => {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return (cb as (e: Error) => void)(err);
    const bad = addrs.map(a => addressProblem(a.address, allowed)).find(Boolean);
    if (bad) return (cb as (e: Error) => void)(new ConnectorError(`${host} resolves to a ${bad}. Add it to CONNECTOR_ALLOWED_HOSTS if it is really your server.`));
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
    else (cb as (e: null, a: string, f: number) => void)(null, addrs[0].address, addrs[0].family);
  });
};

export interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer; url: string; text(): string; json<T = unknown>(): T }
export interface ReqOpts { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number; timeoutMs?: number }

function once(u: URL, o: ReqOpts): Promise<Res> {
  const allowed = allowedHosts().has(u.hostname.toLowerCase().replace(/^\[|\]$/g, ''));
  const max = o.maxBytes ?? Number(process.env.CONNECTOR_MAX_BYTES || 512 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: o.method ?? 'GET', headers: { 'user-agent': 'aerotrace-gate', ...o.headers }, lookup: guardedLookup(allowed), timeout: o.timeoutMs ?? 60000 }, res => {
      const chunks: Buffer[] = []; let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n > max) { req.destroy(new ConnectorError(`${u.host} sent more than ${Math.round(max / 1048576)} MB.`)); return; } chunks.push(c); });
      res.on('end', () => { const body = Buffer.concat(chunks); resolve({ status: res.statusCode ?? 0, headers: res.headers, body, url: u.toString(), text: () => body.toString('utf8'), json: () => JSON.parse(body.toString('utf8')) }); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ConnectorError(`${u.host} did not answer in time.`)));
    req.on('error', e => reject(e instanceof ConnectorError ? e : new ConnectorError(`${u.host}: ${(e as Error).message}`)));
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** GET (or POST) with the guards above. Throws ConnectorError on any non-2xx, with the service's own message when it has one. */
export async function fetchGuarded(url: string, o: ReqOpts & { what?: string; okStatuses?: number[] } = {}): Promise<Res> {
  let u = checkUrl(url); const headers = { ...o.headers };
  for (let hop = 0; hop < 6; hop++) {
    const r = await once(u, { ...o, headers });
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      const next = checkUrl(new URL(r.headers.location, u).toString());
      if (next.host !== u.host) { delete headers.authorization; delete headers.Authorization; delete headers['private-token']; delete headers['PRIVATE-TOKEN']; }
      u = next; continue;
    }
    if (r.status >= 200 && r.status < 300 || o.okStatuses?.includes(r.status)) return r;
    let detail = ''; try { const j = r.json<Record<string, unknown>>(); detail = String(j.message ?? (j.errorMessages as string[] | undefined)?.join('; ') ?? j.error ?? ''); } catch { detail = r.text().slice(0, 200); }
    const hint = r.status === 401 ? ' (check the token reference)' : r.status === 403 ? ' (the token lacks access)' : r.status === 404 ? ' (not found, or the token cannot see it)' : '';
    throw new ConnectorError(`${o.what ?? u.host} answered ${r.status}${hint}${detail ? `: ${detail}` : ''}`, r.status);
  }
  throw new ConnectorError(`${u.host}: too many redirects.`);
}
