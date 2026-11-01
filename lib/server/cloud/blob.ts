// Evidence storage. STORAGE_BACKEND picks where uploaded bundles live: postgres (default), fs, s3, azure or gcs.
// Each backend authenticates with the platform identity (task role, managed identity, service account).
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { azureToken, gcpToken, cloudFetch } from './tokens';

export interface BlobStore {
  kind: 'fs' | 's3' | 'azure' | 'gcs';
  /** Where an object lives, for the record and for operators: s3://bucket/key, https://acct.blob…/c/key, gs://bucket/key, file:///… */
  url(key: string): string;
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

const safeKey = (k: string) => { if (!/^[A-Za-z0-9._\-/]+$/.test(k) || k.includes('..')) throw new Error(`Unsafe storage key ${k}`); return k; };

export function fsStore(dir: string): BlobStore {
  const root = resolve(dir); const p = (k: string) => join(root, safeKey(k));
  return {
    kind: 'fs', url: k => `file://${p(k)}`,
    async put(k, d) { await mkdir(dirname(p(k)), { recursive: true }); await writeFile(p(k), d); },
    async get(k) { try { return new Uint8Array(await readFile(p(k))); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } },
    async delete(k) { await rm(p(k), { force: true }); },
  };
}

export async function s3Store(o: { bucket: string; prefix?: string; region?: string; kmsKeyId?: string; endpoint?: string }): Promise<BlobStore> {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, NoSuchKey } = await import('@aws-sdk/client-s3');
  const c = new S3Client({ region: o.region, ...(o.endpoint ? { endpoint: o.endpoint, forcePathStyle: true } : {}) });
  const key = (k: string) => `${o.prefix ? o.prefix.replace(/\/$/, '') + '/' : ''}${safeKey(k)}`;
  return {
    kind: 's3', url: k => `s3://${o.bucket}/${key(k)}`,
    async put(k, d, ct) {
      await c.send(new PutObjectCommand({ Bucket: o.bucket, Key: key(k), Body: d, ContentType: ct ?? 'application/octet-stream',
        ...(o.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: o.kmsKeyId } : {}) }));
    },
    async get(k) {
      try { const r = await c.send(new GetObjectCommand({ Bucket: o.bucket, Key: key(k) })); return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : null; }
      catch (e) { if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
    },
    async delete(k) { await c.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: key(k) })); },
  };
}

/** Azure Blob over REST with an Entra token (Storage Blob Data Contributor). Single-shot block blobs up to 5000 MiB. */
export function azureStore(o: { accountUrl: string; container: string; prefix?: string }): BlobStore {
  const base = `${o.accountUrl.replace(/\/$/, '')}/${o.container}`;
  const url = (k: string) => `${base}/${o.prefix ? o.prefix.replace(/\/$/, '') + '/' : ''}${safeKey(k)}`;
  const h = async (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${await azureToken('https://storage.azure.com/.default')}`, 'x-ms-version': '2023-11-03', 'x-ms-date': new Date().toUTCString(), ...extra });
  return {
    kind: 'azure', url,
    async put(k, d, ct) { await cloudFetch('Azure Blob', url(k), { method: 'PUT', body: d, headers: await h({ 'x-ms-blob-type': 'BlockBlob', 'content-type': ct ?? 'application/octet-stream' }), timeoutMs: 120000 }); },
    async get(k) { const r = await cloudFetch('Azure Blob', url(k), { headers: await h(), timeoutMs: 120000 }); return r.status === 404 ? null : new Uint8Array(await r.arrayBuffer()); },
    async delete(k) { await cloudFetch('Azure Blob', url(k), { method: 'DELETE', headers: await h() }); },
  };
}

/** Google Cloud Storage over the JSON API with ADC (roles/storage.objectAdmin on the bucket). */
export function gcsStore(o: { bucket: string; prefix?: string; endpoint?: string }): BlobStore {
  const api = (o.endpoint ?? 'https://storage.googleapis.com').replace(/\/$/, '');
  const name = (k: string) => `${o.prefix ? o.prefix.replace(/\/$/, '') + '/' : ''}${safeKey(k)}`;
  const auth = async () => ({ authorization: `Bearer ${await gcpToken()}` });
  return {
    kind: 'gcs', url: k => `gs://${o.bucket}/${name(k)}`,
    async put(k, d, ct) { await cloudFetch('Cloud Storage', `${api}/upload/storage/v1/b/${o.bucket}/o?uploadType=media&name=${encodeURIComponent(name(k))}`, { method: 'POST', body: d, headers: { ...(await auth()), 'content-type': ct ?? 'application/octet-stream' }, timeoutMs: 120000 }); },
    async get(k) { const r = await cloudFetch('Cloud Storage', `${api}/storage/v1/b/${o.bucket}/o/${encodeURIComponent(name(k))}?alt=media`, { headers: await auth(), timeoutMs: 120000 }); return r.status === 404 ? null : new Uint8Array(await r.arrayBuffer()); },
    async delete(k) { await cloudFetch('Cloud Storage', `${api}/storage/v1/b/${o.bucket}/o/${encodeURIComponent(name(k))}`, { method: 'DELETE', headers: await auth() }); },
  };
}

let memo: Promise<BlobStore | null> | null = null;
/** null means "keep bundles in Postgres" (the default). */
export function blobStoreFromEnv(env: Record<string, string | undefined> = process.env): Promise<BlobStore | null> {
  if (memo) return memo;
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`STORAGE_BACKEND=${env.STORAGE_BACKEND} needs ${k}`); return v; };
  memo = (async () => {
    switch ((env.STORAGE_BACKEND || 'postgres').toLowerCase()) {
      case 'postgres': return null;
      case 'fs': return fsStore(need('STORAGE_FS_DIR'));
      case 's3': return s3Store({ bucket: need('STORAGE_S3_BUCKET'), prefix: env.STORAGE_S3_PREFIX, region: env.AWS_REGION, kmsKeyId: env.STORAGE_S3_KMS_KEY_ID, endpoint: env.STORAGE_S3_ENDPOINT });
      case 'azure': return azureStore({ accountUrl: need('STORAGE_AZURE_ACCOUNT_URL'), container: need('STORAGE_AZURE_CONTAINER'), prefix: env.STORAGE_AZURE_PREFIX });
      case 'gcs': return gcsStore({ bucket: need('STORAGE_GCS_BUCKET'), prefix: env.STORAGE_GCS_PREFIX, endpoint: env.STORAGE_GCS_ENDPOINT });
      default: throw new Error(`Unknown STORAGE_BACKEND "${env.STORAGE_BACKEND}". Use postgres, fs, s3, azure or gcs.`);
    }
  })();
  return memo;
}
export function resetBlobStoreForTests() { memo = null; }
