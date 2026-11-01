// Access tokens from the platform's own identity: Azure managed identity / workload identity, Google ADC.
// No keys in configuration. AZURE_ACCESS_TOKEN / GCP_ACCESS_TOKEN exist only so tests can point at local fakes.
let azureCred: { getToken(scope: string): Promise<{ token: string } | null> } | null = null;
export async function azureToken(scope: string): Promise<string> {
  if (process.env.AZURE_ACCESS_TOKEN) return process.env.AZURE_ACCESS_TOKEN;
  if (!azureCred) {
    const { DefaultAzureCredential } = await import('@azure/identity');
    azureCred = new DefaultAzureCredential(process.env.AZURE_CLIENT_ID ? { managedIdentityClientId: process.env.AZURE_CLIENT_ID } : {});
  }
  const t = await azureCred.getToken(scope);
  if (!t) throw new Error(`Azure identity returned no token for ${scope}`);
  return t.token;
}

let gcpAuth: { getAccessToken(): Promise<string | null | undefined> } | null = null;
export async function gcpToken(): Promise<string> {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  if (!gcpAuth) {
    const { GoogleAuth } = await import('google-auth-library');
    gcpAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const t = await gcpAuth.getAccessToken();
  if (!t) throw new Error('Google Application Default Credentials returned no token');
  return t;
}

/** fetch with a timeout and a readable error that names the service, never the token. */
export async function cloudFetch(service: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
  if (!res.ok && res.status !== 404) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${service} ${init.method ?? 'GET'} failed: ${res.status} ${text}`);
  }
  return res;
}
