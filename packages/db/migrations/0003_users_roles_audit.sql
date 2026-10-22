-- 0003 Users, roles, sessions, the login directory and the append-only audit log
-- (W0-09; PLT-04, PLT-05, PLT-08; data model §2; D-081).

-- Login directory: shop code -> tenant. The one table readable across tenants; it holds nothing else.
CREATE TABLE erp.tenant_directory (
  code text PRIMARY KEY CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  tenant_id uuid NOT NULL UNIQUE REFERENCES erp.tenants (id)
);
ALTER TABLE erp.tenant_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.tenant_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY directory_read ON erp.tenant_directory FOR SELECT USING (true);
-- Written only by the platform setup path (PLT-11), in the new tenant's context.
CREATE POLICY directory_register ON erp.tenant_directory FOR INSERT WITH CHECK (tenant_id = erp.current_tenant_id());
REVOKE INSERT, UPDATE, DELETE ON erp.tenant_directory FROM erp_app;

CREATE TABLE erp.users (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{1,64}$'),
  email text,
  full_name text NOT NULL,
  -- For quick PIN unlock on a counter (W0-10).
  short_code text CHECK (short_code ~ '^[A-Za-z0-9]{1,8}$'),
  -- Argon2id (D-081). Back-office login checks only this, never the PIN.
  password_hash text,
  -- PIN unlock on enrolled devices only (W0-10).
  pin_verifier text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password_changed_at timestamptz,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX users_username_uq ON erp.users (tenant_id, lower(username));
CREATE UNIQUE INDEX users_email_uq ON erp.users (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_short_code_uq ON erp.users (tenant_id, short_code) WHERE short_code IS NOT NULL;
SELECT erp.enable_tenant_rls('erp.users');
SELECT erp.enable_sync('erp.users');
SELECT erp.enable_audit('erp.users');

-- Login bookkeeping, kept apart from users so a login doesn't create audit or sync noise.
CREATE TABLE erp.user_login_state (
  user_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  failed_logins smallint NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  FOREIGN KEY (tenant_id, user_id) REFERENCES erp.users (tenant_id, id)
);
SELECT erp.enable_tenant_rls('erp.user_login_state');

CREATE TABLE erp.roles (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  name text NOT NULL,
  -- The template it was created from (packages/domain ROLE_TEMPLATES), if any.
  template_key text CHECK (template_key IN ('owner', 'manager', 'cashier', 'salesman', 'purchaser', 'accountant')),
  permissions text[] NOT NULL,
  limits jsonb NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX roles_name_uq ON erp.roles (tenant_id, lower(name));
SELECT erp.enable_tenant_rls('erp.roles');
SELECT erp.enable_sync('erp.roles');
SELECT erp.enable_audit('erp.roles');

CREATE TABLE erp.user_roles (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  -- NULL = every branch.
  branch_id uuid,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES erp.roles (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, role_id, branch_id)
);
SELECT erp.enable_tenant_rls('erp.user_roles');
SELECT erp.enable_sync('erp.user_roles');
SELECT erp.enable_audit('erp.user_roles');

-- Back-office sessions (D-081): only the SHA-256 of the token is stored.
CREATE TABLE erp.sessions (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text,
  FOREIGN KEY (tenant_id, user_id) REFERENCES erp.users (tenant_id, id)
);
CREATE INDEX sessions_user_idx ON erp.sessions (tenant_id, user_id);
SELECT erp.enable_tenant_rls('erp.sessions');

-- The audit log (PLT-08): append-only for every role, the owner included.
CREATE TABLE erp.audit_log (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id uuid,
  device_id uuid,
  request_id text,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip text
);
CREATE INDEX audit_log_entity_idx ON erp.audit_log (tenant_id, entity, entity_id, at);
SELECT erp.enable_tenant_rls('erp.audit_log');
REVOKE UPDATE, DELETE ON erp.audit_log FROM erp_app;

CREATE FUNCTION erp.refuse_audit_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'erp.audit_log is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON erp.audit_log
  FOR EACH ROW EXECUTE FUNCTION erp.refuse_audit_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON erp.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION erp.refuse_audit_change();

-- Writes one audit row per insert / update / soft delete, before and after, without the secret columns
-- named in the trigger arguments. Updates that change only sync or audit columns are skipped.
CREATE FUNCTION erp.audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  noise constant text[] := ARRAY['row_version', 'txid', 'updated_at', 'updated_by_user_id'];
  -- TG_ARGV is NULL, not empty, when the trigger has no arguments.
  secrets constant text[] := coalesce(TG_ARGV, '{}');
  old_row jsonb;
  new_row jsonb := to_jsonb(NEW) - secrets;
  act text := 'create';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD) - secrets;
    IF (old_row - noise) = (new_row - noise) THEN
      RETURN NULL;
    END IF;
    act := CASE WHEN old_row->>'deleted_at' IS NULL AND new_row->>'deleted_at' IS NOT NULL THEN 'delete' ELSE 'update' END;
  END IF;
  INSERT INTO erp.audit_log (tenant_id, user_id, device_id, request_id, action, entity, entity_id, before, after)
  VALUES (
    coalesce(new_row->>'tenant_id', new_row->>'id')::uuid,
    erp.current_user_id(),
    nullif(current_setting('app.device_id', true), '')::uuid,
    nullif(current_setting('app.request_id', true), ''),
    act, TG_TABLE_NAME, (new_row->>'id')::uuid, old_row, new_row);
  RETURN NULL;
END $$;

CREATE FUNCTION erp.enable_audit_log(tbl regclass, secret_columns text[] DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION erp.audit_row(%s)',
    tbl, (SELECT string_agg(quote_literal(c), ', ') FROM unnest(secret_columns) AS c));
END $$;

SELECT erp.enable_audit_log('erp.tenants');
SELECT erp.enable_audit_log('erp.branches');
SELECT erp.enable_audit_log('erp.locations');
SELECT erp.enable_audit_log('erp.users', ARRAY['password_hash', 'pin_verifier']);
SELECT erp.enable_audit_log('erp.roles');
SELECT erp.enable_audit_log('erp.user_roles');
