// Secret references: any environment variable NAME can be given as NAME_REF pointing at a secret manager.
// Resolved once at start-up, before anything reads process.env. See docs/cloud/configuration.md.
import { readFileSync } from 'node:fs';
import { azureToken, gcpToken, cloudFetch } from './tokens';

export async function resolveRef(ref: string): Promise<string> {
  const u = ref.trim();
  if (u.startsWith('env://')) { const v = process.env[u.slice(6)]; if (v === undefined) throw new Error(`${u}: variable not set`); return v; }
  if (u.startsWith('file://')) return readFileSync(u.slice(7), 'utf8').replace(/\r?\n$/, '');
  if (u.startsWith('aws-sm://')) {
    const [id, jsonKey] = u.slice(9).split('#');
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const c = new SecretsManagerClient(process.env.AWS_SECRETS_ENDPOINT ? { endpoint: process.env.AWS_SECRETS_ENDPOINT } : {});
    const out = await c.send(new GetSecretValueCommand({ SecretId: id }));
    const s = out.SecretString ?? (out.SecretBinary ? Buffer.from(out.SecretBinary).toString('utf8') : '');
    if (!jsonKey) return s;
    const v = (JSON.parse(s) as Record<string, unknown>)[jsonKey]; if (v === undefined) throw new Error(`${id} has no key "${jsonKey}"`); return String(v);
  }
  if (u.startsWith('azure-kv://')) {
    const [vault, name, version] = u.slice(11).split('/');
    const base = process.env.AZURE_KEYVAULT_ENDPOINT?.replace(/\/$/, '') ?? `https://${vault}.vault.azure.net`;
    const res = await cloudFetch('Azure Key Vault', `${base}/secrets/${encodeURIComponent(name)}${version ? `/${version}` : ''}?api-version=7.4`, { headers: { authorization: `Bearer ${await azureToken('https://vault.azure.net/.default')}` } });
    if (res.status === 404) throw new Error(`Key Vault secret ${name} not found in ${vault}`);
    return ((await res.json()) as { value: string }).value;
  }
  if (u.startsWith('gcp-sm://')) {
    const name = u.slice(9);
    const base = process.env.GCP_SECRETMANAGER_ENDPOINT?.replace(/\/$/, '') ?? 'https://secretmanager.googleapis.com';
    const res = await cloudFetch('Secret Manager', `${base}/v1/${name}:access`, { headers: { authorization: `Bearer ${await gcpToken()}` } });
    if (res.status === 404) throw new Error(`Secret ${name} not found`);
    return Buffer.from(((await res.json()) as { payload: { data: string } }).payload.data, 'base64').toString('utf8');
  }
  throw new Error(`Unknown secret reference "${u.split('://')[0]}://". Use aws-sm://, azure-kv://, gcp-sm://, file:// or env://`);
}

/** For every NAME_REF, set NAME (unless already set). Fails loudly: a missing secret should stop the container. */
export async function resolveEnvRefs(env: Record<string, string | undefined> = process.env): Promise<string[]> {
  const done: string[] = [];
  for (const [k, ref] of Object.entries(env)) {
    if (!k.endsWith('_REF') || !ref || k === 'GITHUB_REF') continue;
    const name = k.slice(0, -4);
    if (env[name]) continue;
    try { env[name] = await resolveRef(ref); done.push(name); }
    catch (e) { throw new Error(`Could not resolve ${k} (${ref.split('://')[0]}://…): ${(e as Error).message}`); }
  }
  return done;
}
