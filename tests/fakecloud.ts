// A local stand-in for the cloud APIs AeroTrace calls, speaking their real wire formats closely enough for the
// official AWS SDK and our REST clients: S3, KMS, Secrets Manager; Azure Blob + Key Vault; GCS, Cloud KMS, Secret Manager.
// Used by tests/cloud.test.ts and by the e2e run with STORAGE_BACKEND=s3 / SIGNER=aws-kms. Not a security boundary.
import http from 'node:http';
import { createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import { p256 } from '@noble/curves/p256';

const keyPair = () => {
  const priv = p256.utils.randomPrivateKey(); const pub = p256.getPublicKey(priv, false);
  const jwk = { kty: 'EC', crv: 'P-256', x: Buffer.from(pub.slice(1, 33)).toString('base64url'), y: Buffer.from(pub.slice(33)).toString('base64url') };
  const pubKey: KeyObject = createPublicKey({ key: jwk, format: 'jwk' });
  void createPrivateKey;
  return { priv, jwk, spki: pubKey.export({ type: 'spki', format: 'der' }), pem: pubKey.export({ type: 'spki', format: 'pem' }).toString() };
};
// Sign a digest as-is (what KMS/HSMs do), returning DER or raw r||s.
const signDigest = (priv: Uint8Array, digest: Uint8Array, der: boolean) => { const s = p256.sign(digest, priv, { prehash: false, lowS: false }); return Buffer.from(der ? s.toDERRawBytes() : s.toCompactRawBytes()); };

export interface FakeCloud { url: string; stop(): Promise<void>; objects: Map<string, Buffer>; secrets: Record<string, string>; calls: string[]; tokens: Set<string> }

export async function startFakeCloud(port = 0, secrets: Record<string, string> = {}): Promise<FakeCloud> {
  const objects = new Map<string, Buffer>(); const calls: string[] = []; const tokens = new Set<string>(); const spans: string[] = []; const metricNames: string[] = [];
  const aws = keyPair(), az = keyPair(), gcp = keyPair();
  const read = (req: http.IncomingMessage) => new Promise<Buffer>(r => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
  const json = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(JSON.stringify(body)); };
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x'); const body = await read(req);
    const auth = req.headers.authorization ?? ''; if (auth.startsWith('Bearer ')) tokens.add(auth.slice(7));
    const target = String(req.headers['x-amz-target'] ?? '');
    calls.push(`${req.method} ${url.pathname}${target ? ' ' + target : ''}`);
    try {
      // ---- OTLP/HTTP receiver (what a collector sidecar would get) and a state dump for the e2e suite ----
      if (url.pathname === '/v1/traces' || url.pathname === '/v1/metrics') {
        const txt = body.toString(); const names = [...txt.matchAll(/"name":"([^"]+)"/g)].map(x => x[1]);
        (url.pathname === '/v1/traces' ? spans : metricNames).push(...names); return json(res, 200, {});
      }
      if (url.pathname === '/__state') return json(res, 200, { objects: [...objects.keys()], calls, spans: [...new Set(spans)], metrics: [...new Set(metricNames)] });
      // ---- AWS JSON protocols (KMS, Secrets Manager) ----
      if (target === 'TrentService.GetPublicKey') return json(res, 200, { KeyId: 'arn:aws:kms:us-east-1:111122223333:key/fake', KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', PublicKey: aws.spki.toString('base64'), SigningAlgorithms: ['ECDSA_SHA_256'] }, 'application/x-amz-json-1.1');
      if (target === 'TrentService.Sign') { const b = JSON.parse(body.toString()); if (b.MessageType !== 'DIGEST') return json(res, 400, { __type: 'ValidationException' }); return json(res, 200, { KeyId: b.KeyId, Signature: signDigest(aws.priv, Buffer.from(b.Message, 'base64'), true).toString('base64'), SigningAlgorithm: 'ECDSA_SHA_256' }, 'application/x-amz-json-1.1'); }
      if (target === 'secretsmanager.GetSecretValue') { const id = JSON.parse(body.toString()).SecretId; return id in secrets ? json(res, 200, { ARN: id, Name: id, SecretString: secrets[id] }, 'application/x-amz-json-1.1') : json(res, 400, { __type: 'ResourceNotFoundException', message: 'not found' }, 'application/x-amz-json-1.1'); }
      // ---- Azure Key Vault ----
      let m = /^\/keys\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      if (m && req.method === 'GET') return json(res, 200, { key: { kid: `http://${req.headers.host}/keys/${m[1]}/v1`, kty: 'EC', crv: 'P-256', x: az.jwk.x, y: az.jwk.y, key_ops: ['sign', 'verify'] } });
      m = /^\/keys\/([^/]+)\/([^/]+)\/sign$/.exec(url.pathname);
      if (m && req.method === 'POST') { const b = JSON.parse(body.toString()); if (b.alg !== 'ES256') return json(res, 400, { error: 'alg' }); return json(res, 200, { kid: `keys/${m[1]}/${m[2]}`, value: signDigest(az.priv, Buffer.from(b.value, 'base64url'), false).toString('base64url') }); }
      m = /^\/secrets\/([^/]+)$/.exec(url.pathname);
      if (m && req.method === 'GET') { const k = `azure:${m[1]}`; return k in secrets ? json(res, 200, { value: secrets[k], id: url.pathname }) : json(res, 404, { error: { code: 'SecretNotFound' } }); }
      // ---- Google Cloud KMS + Secret Manager ----
      m = /^\/v1\/(projects\/.+\/cryptoKeyVersions\/[^/:]+)\/publicKey$/.exec(url.pathname);
      if (m) return json(res, 200, { pem: gcp.pem, algorithm: 'EC_SIGN_P256_SHA256', name: m[1] });
      m = /^\/v1\/(projects\/.+\/cryptoKeyVersions\/[^/:]+):asymmetricSign$/.exec(url.pathname);
      if (m) { const b = JSON.parse(body.toString()); return json(res, 200, { signature: signDigest(gcp.priv, Buffer.from(b.digest.sha256, 'base64'), true).toString('base64'), name: m[1] }); }
      m = /^\/v1\/(projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/:]+):access$/.exec(url.pathname);
      if (m) { const k = `gcp:${m[1]}`; return k in secrets ? json(res, 200, { name: m[1], payload: { data: Buffer.from(secrets[k]).toString('base64') } }) : json(res, 404, { error: { code: 404 } }); }
      // ---- Google Cloud Storage JSON API ----
      m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
      if (m && req.method === 'POST') { objects.set(`gs://${m[1]}/${url.searchParams.get('name')}`, body); return json(res, 200, { name: url.searchParams.get('name'), bucket: m[1], size: String(body.length) }); }
      m = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(url.pathname);
      if (m) { const k = `gs://${m[1]}/${decodeURIComponent(m[2])}`;
        if (req.method === 'DELETE') { objects.delete(k); res.writeHead(204).end(); return; }
        const o = objects.get(k); if (!o) return json(res, 404, { error: { code: 404 } }); res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(o); return; }
      // ---- Azure Blob (container/blob) and S3 path-style (bucket/key) share the shape /<container>/<key> ----
      m = /^\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (m) {
        const isAzure = 'x-ms-version' in req.headers; const k = `${isAzure ? 'az' : 's3'}://${m[1]}/${decodeURIComponent(m[2])}`;
        if (isAzure && !auth.startsWith('Bearer ')) return json(res, 401, { error: 'no token' });
        if (req.method === 'PUT') { if (isAzure && req.headers['x-ms-blob-type'] !== 'BlockBlob') return json(res, 400, { error: 'blob type' }); objects.set(k, body); res.writeHead(201, isAzure ? {} : { etag: '"1"' }).end(); return; }
        if (req.method === 'DELETE') { objects.delete(k); res.writeHead(isAzure ? 202 : 204).end(); return; }
        const o = objects.get(k);
        if (!o) { if (isAzure) return json(res, 404, { error: 'BlobNotFound' }); res.writeHead(404, { 'content-type': 'application/xml' }); res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>none</Message></Error>'); return; }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': o.length }); res.end(o); return;
      }
      json(res, 404, { error: `fake cloud: no route for ${req.method} ${url.pathname}` });
    } catch (e) { json(res, 500, { error: (e as Error).message }); }
  });
  await new Promise<void>(r => srv.listen(port, '127.0.0.1', () => r()));
  const a = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${a.port}`, objects, secrets, calls, tokens, stop: () => new Promise(r => srv.close(() => r())) };
}

// `tsx tests/fakecloud.ts 4599` runs it standalone for the e2e suite.
if (process.argv[1]?.endsWith('fakecloud.ts')) {
  startFakeCloud(Number(process.argv[2] || 4599), JSON.parse(process.env.FAKE_SECRETS || '{}')).then(f => console.log(`fake cloud on ${f.url}`));
}
