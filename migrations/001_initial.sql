-- Owner disposition O4 (2026-10-30 21:02/21:08 PDT): the owner pre-creates
-- app_runtime (NOLOGIN NOSUPERUSER NOBYPASSRLS) and GRANTs it to the runtime
-- identity in the Neon console; proof2_migrator stays NOCREATEROLE. This guard
-- makes the migration idempotent for that pre-created role and fails closed if an
-- existing app_runtime has unsafe attributes.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'
    AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'existing app_runtime role has unsafe attributes';
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (tenant_id IN ('tenant-a', 'tenant-b')),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  UNIQUE (tenant_id, id)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE records (
  tenant_id text NOT NULL CHECK (tenant_id IN ('tenant-a', 'tenant-b')),
  id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  PRIMARY KEY (tenant_id, id)
);
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
ALTER TABLE records FORCE ROW LEVEL SECURITY;
CREATE POLICY account_read ON accounts FOR SELECT TO app_runtime USING (
  username = current_setting('app.login', true) OR id::text = current_setting('app.user_id', true)
);
CREATE POLICY session_read ON sessions FOR SELECT TO app_runtime USING (token_hash = current_setting('app.token_hash', true));
CREATE POLICY session_insert ON sessions FOR INSERT TO app_runtime WITH CHECK (
  token_hash = current_setting('app.token_hash', true) AND user_id::text = current_setting('app.user_id', true)
);
CREATE POLICY session_delete ON sessions FOR DELETE TO app_runtime USING (token_hash = current_setting('app.token_hash', true));
CREATE POLICY record_scope ON records FOR ALL TO app_runtime
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT ON accounts TO app_runtime;
GRANT SELECT, INSERT, DELETE ON sessions TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON records TO app_runtime;
-- Maintenance-only owner policies. Runtime startup rejects membership in any table owner.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['accounts','sessions','records'] LOOP
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
  END LOOP;
END $$;
-- The existing GRANT app_runtime TO <runtime identity> is issued by scripts/migrate.ts
-- inside the migration transaction and is already idempotent; no CREATEROLE is
-- granted to proof2_migrator.
