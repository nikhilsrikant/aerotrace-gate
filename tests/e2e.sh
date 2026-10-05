#!/usr/bin/env bash
# Local end-to-end run: fresh database, migrate, web + worker, then tests/e2e.ts. Needs DATABASE_URL pointing at an empty DB you can drop.
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL to a throwaway database}"
export PUBLIC_URL=${PUBLIC_URL:-http://localhost:3999} PASSKEY_ORIGIN=${PASSKEY_ORIGIN:-http://localhost:3999}
export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=Admin-pass-2026 ADMIN_NAME="Ada Admin"
FAKE=""
if [ "${CLOUD_E2E:-}" = "1" ]; then
  # Cloud mode: evidence in "S3", decisions signed by "AWS KMS", the session secret from "Secrets Manager",
  # traces and metrics to an OTLP endpoint. All served by tests/fakecloud.ts on port 4599.
  FAKE_SECRETS='{"aerotrace/e2e/session":"e2e-session-secret-from-secrets-manager-0123456789"}' npx tsx tests/fakecloud.ts 4599 > /tmp/aerotrace-fakecloud.log 2>&1 & FAKE=$!
  export AWS_ACCESS_KEY_ID=AKIAFAKE AWS_SECRET_ACCESS_KEY=fake AWS_REGION=us-east-1
  export STORAGE_BACKEND=s3 STORAGE_S3_BUCKET=evidence STORAGE_S3_ENDPOINT=http://127.0.0.1:4599
  export SIGNER=aws-kms SIGNER_AWS_KMS_KEY_ID=alias/aerotrace-signing SIGNER_AWS_KMS_ENDPOINT=http://127.0.0.1:4599
  export SESSION_SECRET_REF=aws-sm://aerotrace/e2e/session AWS_SECRETS_ENDPOINT=http://127.0.0.1:4599
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4599 OTEL_METRIC_EXPORT_INTERVAL=2000 OTEL_BSP_SCHEDULE_DELAY=500
  unset SESSION_SECRET; sleep 3
else
  export SESSION_SECRET=${SESSION_SECRET:-e2e-session-secret-0123456789-abcdef}
fi
# Git, Jira and CI stand-in for the evidence-source step.
npx tsx tests/fakeforge.ts 4598 > /tmp/aerotrace-fakeforge.log 2>&1 & FORGE=$!
export FORGE_URL=http://127.0.0.1:4598 CONNECTOR_ALLOWED_HOSTS=127.0.0.1,localhost CONNECTOR_GH_TOKEN=gh-token CONNECTOR_JIRA_TOKEN=jira-token
psql "$DATABASE_URL" -qc 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
npm run build >/dev/null
node dist/cli.mjs migrate
node dist/cli.mjs export-sample /tmp/aerotrace-sample.zip
cp -r .next/static .next/standalone/.next/
PORT=3999 HOSTNAME=127.0.0.1 node dist/boot.mjs "$PWD/.next/standalone/server.js" > /tmp/aerotrace-web.log 2>&1 & WEB=$!
SCHEDULER_INTERVAL_MS=2000 JOB_STALE_MS=5000 WORKER_METRICS_PORT=9499 node dist/cli.mjs worker > /tmp/aerotrace-worker.log 2>&1 & WRK=$!
trap 'kill $WEB $WRK $FAKE $FORGE 2>/dev/null || true' EXIT
sleep 5
BASE=http://127.0.0.1:3999 SAMPLE_ZIP=/tmp/aerotrace-sample.zip npx tsx tests/e2e.ts
