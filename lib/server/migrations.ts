// Schema migrations, applied in order inside a transaction by `aerotrace migrate`. Never edit a shipped one; add the next.
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: 'initial schema', sql: `
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL, data jsonb NOT NULL);
CREATE UNIQUE INDEX users_email ON users (lower(email));
CREATE TABLE groups (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE UNIQUE INDEX groups_name ON groups (lower(data->>'name'));
CREATE TABLE roles (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE policies (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE delegations (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE api_tokens (id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, data jsonb NOT NULL);
CREATE TABLE sessions (id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, user_id text NOT NULL, expires_at timestamptz NOT NULL, data jsonb NOT NULL);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE TABLE login_attempts (id bigserial PRIMARY KEY, key text NOT NULL, ok boolean NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE INDEX login_attempts_key ON login_attempts (key, at);
CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE secrets (name text PRIMARY KEY, value text NOT NULL);
CREATE TABLE datasets (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), bundle bytea, corpus_gz bytea);
CREATE TABLE runs (
  id text PRIMARY KEY, dataset_id text NOT NULL, module text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL,
  requested_by text NOT NULL, schedule_id text, data jsonb NOT NULL, result_gz bytea, progress jsonb);
CREATE INDEX runs_status ON runs (status, created_at DESC);
CREATE INDEX runs_module ON runs (dataset_id, module, created_at DESC);
CREATE INDEX runs_schedule ON runs (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE TABLE schedules (id text PRIMARY KEY, enabled boolean NOT NULL, next_run_at timestamptz, data jsonb NOT NULL);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;
CREATE TABLE jobs (
  id text PRIMARY KEY, kind text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3, run_after timestamptz NOT NULL, locked_by text, heartbeat_at timestamptz, error text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz);
CREATE INDEX jobs_ready ON jobs (status, run_after);
CREATE TABLE audit_log (
  seq bigint PRIMARY KEY, at timestamptz NOT NULL, actor_id text NOT NULL, actor_name text NOT NULL, action text NOT NULL,
  target text NOT NULL, details jsonb NOT NULL, prev_hash text NOT NULL, hash text NOT NULL);
CREATE INDEX audit_target ON audit_log (target);
-- The audit log is append-only. Even the application's own database role cannot rewrite history.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
` },
  { version: 2, name: 'passkeys', sql: `
CREATE TABLE passkeys (id text PRIMARY KEY, user_id text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX passkeys_user ON passkeys (user_id);
CREATE TABLE passkey_challenges (id text PRIMARY KEY, expires_at timestamptz NOT NULL, data jsonb NOT NULL);
CREATE INDEX passkey_challenges_exp ON passkey_challenges (expires_at);
` },
  { version: 3, name: 'invites', sql: `
CREATE TABLE invites (id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, user_id text NOT NULL, data jsonb NOT NULL);
CREATE INDEX invites_user ON invites (user_id);
` },
  { version: 4, name: 'workspaces', sql: `
CREATE TABLE workspaces (id text PRIMARY KEY, slug text NOT NULL UNIQUE, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO workspaces (id, slug, data) VALUES ('ws_default', 'default',
  jsonb_build_object('id', 'ws_default', 'name', COALESCE((SELECT value->>'orgName' FROM settings WHERE key='app'), 'Default program'), 'slug', 'default', 'createdAt', now(), 'createdBy', 'migration'));
-- Everything that existed before workspaces belongs to the default one.
UPDATE groups SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
UPDATE policies SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
UPDATE delegations SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
UPDATE api_tokens SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
UPDATE datasets SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
UPDATE runs SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
UPDATE schedules SET data = data || '{"workspaceId":"ws_default"}' WHERE NOT data ? 'workspaceId';
-- People keep their roles, now as roles in the default workspace; administrators become platform administrators.
UPDATE users SET data = data || jsonb_build_object('workspaceRoles', jsonb_build_object('ws_default', COALESCE(data->'roleIds', '[]'::jsonb)),
  'platformAdmin', COALESCE(data->'roleIds', '[]'::jsonb) ? 'role_admin') WHERE NOT data ? 'workspaceRoles';
INSERT INTO settings (key, value) SELECT 'ws:ws_default', value - 'passkeys' FROM settings WHERE key='app' ON CONFLICT DO NOTHING;
CREATE INDEX runs_workspace ON runs ((COALESCE(data->>'workspaceId', 'ws_default')), created_at DESC);
CREATE INDEX audit_workspace ON audit_log ((COALESCE(details->>'workspace', 'ws_default')), seq DESC);
` },
  { version: 5, name: 'evidence sources', sql: `
CREATE TABLE sources (id text PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sources_workspace ON sources ((COALESCE(data->>'workspaceId', 'ws_default')));
` },
];
