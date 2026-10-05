// Cloud adapters against the local fake cloud: storage, KMS signing (with key history), secret references.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { startFakeCloud } from './fakecloud';
import { s3Store, azureStore, gcsStore, fsStore } from '../lib/server/cloud/blob';
import { awsKmsSigner, azureKeyVaultSigner, gcpKmsSigner, signerFromEnv } from '../lib/server/cloud/signers';
import { resolveRef, resolveEnvRefs } from '../lib/server/cloud/secrets';
import { MemRepo } from '../lib/core/memRepo';

(async () => {
  const cloud = await startFakeCloud(0, {
    'aerotrace/prod/session': 's'.repeat(40), 'aerotrace/prod/db': JSON.stringify({ url: 'postgres://u:p@db/aerotrace' }),
    'azure:session-secret': 'from-key-vault', 'gcp:projects/p1/secrets/session/versions/latest': 'from-secret-manager',
  });
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIAFAKE', AWS_SECRET_ACCESS_KEY: 'fake', AWS_REGION: 'us-east-1', AZURE_ACCESS_TOKEN: 'az-token', GCP_ACCESS_TOKEN: 'gcp-token' });
  const data = new TextEncoder().encode('PK\u0003\u0004 evidence bundle bytes '.repeat(200));

  // ---- storage ----
  const stores = [
    await s3Store({ bucket: 'evidence', prefix: 'prod', endpoint: cloud.url, region: 'us-east-1', kmsKeyId: 'alias/aerotrace-s3' }),
    azureStore({ accountUrl: cloud.url, container: 'evidence' }),
    gcsStore({ bucket: 'evidence-gcs', endpoint: cloud.url }),
    fsStore('/tmp/aerotrace-fs-store-test'),
  ];
  for (const st of stores) {
    await st.put('datasets/ds_1/bundle.zip', data, 'application/zip');
    const back = await st.get('datasets/ds_1/bundle.zip');
    assert.ok(back && Buffer.from(back).equals(Buffer.from(data)), `${st.kind} round trip`);
    assert.equal(await st.get('datasets/missing/bundle.zip'), null, `${st.kind} missing -> null`);
    await st.delete('datasets/ds_1/bundle.zip'); assert.equal(await st.get('datasets/ds_1/bundle.zip'), null, `${st.kind} delete`);
    assert.throws(() => st.url('../etc/passwd'), /Unsafe/);
    console.log(`storage ${st.kind}: put/get/delete ok (${st.url('datasets/ds_1/bundle.zip')})`);
  }
  assert.ok(cloud.tokens.has('az-token') && cloud.tokens.has('gcp-token'), 'platform tokens were sent');

  // ---- signing: each KMS signs; signatures verify with only the public key, in the offline (raw r||s) format ----
  const repo = new MemRepo();
  const signers = [
    ['aws-kms', await awsKmsSigner(repo, 'alias/aerotrace-signing', cloud.url)],
    ['azure-kv', await azureKeyVaultSigner(repo, `${cloud.url}/keys/aerotrace-signing`)],
    ['gcp-kms', await gcpKmsSigner(repo, 'projects/p1/locations/us/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1', cloud.url)],
  ] as const;
  const text = '{"action":"approve","reportHash":"abc"}';
  for (const [name, s] of signers) {
    assert.equal(s.alg, 'ES256');
    const sig = await s.sign(text);
    assert.ok(await s.verify(text, sig), `${name} verifies its own signature`);
    assert.equal(await s.verify(text + 'x', sig), false, `${name} rejects a changed payload`);
    const jwk = s.publicKey()!;
    assert.ok(verify('sha256', Buffer.from(text), { key: createPublicKey({ key: jwk as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.value, 'base64')), `${name} verifies offline with just the JWK`);
    console.log(`signer ${name}: ES256 key ${s.keyId}, signs, verifies, verifies offline`);
  }

  // Key history: sign with the built-in key, move to a KMS, the old signature still verifies.
  const repo2 = new MemRepo();
  const local = await signerFromEnv(repo2, { SIGNER: 'local' });
  const oldSig = await local.sign(text);
  const moved = await signerFromEnv(repo2, { SIGNER: 'aws-kms', SIGNER_AWS_KMS_KEY_ID: 'alias/x', SIGNER_AWS_KMS_ENDPOINT: cloud.url });
  assert.equal(moved.alg, 'ES256'); assert.notEqual(moved.keyId, local.keyId);
  assert.ok(await moved.verify(text, oldSig), 'Ed25519 signature from before the move still verifies');
  assert.equal(moved.publicKeys!().length, 2);
  console.log('key history: Ed25519 signature still verifies after moving to KMS; /api/keys lists both');
  await assert.rejects(signerFromEnv(repo2, { SIGNER: 'aws-kms' }), /needs SIGNER_AWS_KMS_KEY_ID/);

  // ---- secret references ----
  process.env.AWS_SECRETS_ENDPOINT = cloud.url; process.env.AZURE_KEYVAULT_ENDPOINT = cloud.url; process.env.GCP_SECRETMANAGER_ENDPOINT = cloud.url;
  assert.equal(await resolveRef('aws-sm://aerotrace/prod/session'), 's'.repeat(40));
  assert.equal(await resolveRef('aws-sm://aerotrace/prod/db#url'), 'postgres://u:p@db/aerotrace');
  assert.equal(await resolveRef('azure-kv://myvault/session-secret'), 'from-key-vault');
  assert.equal(await resolveRef('gcp-sm://projects/p1/secrets/session/versions/latest'), 'from-secret-manager');
  await assert.rejects(resolveRef('azure-kv://myvault/nope'), /not found/);
  await assert.rejects(resolveRef('vault://x'), /Unknown secret reference/);
  const env: Record<string, string | undefined> = { SESSION_SECRET_REF: 'aws-sm://aerotrace/prod/session', DATABASE_URL_REF: 'aws-sm://aerotrace/prod/db#url', ALREADY: 'kept', ALREADY_REF: 'aws-sm://missing', GITHUB_REF: 'refs/heads/main' };
  const done = await resolveEnvRefs(env);
  assert.deepEqual(done.sort(), ['DATABASE_URL', 'SESSION_SECRET']);
  assert.equal(env.DATABASE_URL, 'postgres://u:p@db/aerotrace'); assert.equal(env.ALREADY, 'kept');
  await assert.rejects(resolveEnvRefs({ X_REF: 'aws-sm://missing' }), /Could not resolve X_REF/);
  console.log('secrets: aws-sm (plain and #json key), azure-kv, gcp-sm, env and errors behave');

  await cloud.stop();
  console.log('cloud: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
