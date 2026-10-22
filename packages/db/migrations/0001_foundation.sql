-- 0001 Foundation (W0-07, D-078): schema, IDs, tenant context, and the standard helpers every table uses.
-- Runs as erp_owner. Migrations are immutable once applied: change things in a new file.

CREATE SCHEMA erp;
GRANT USAGE ON SCHEMA erp TO erp_app;

-- One global sequence orders changes inside a transaction for the change feed (architecture §5.3).
CREATE SEQUENCE erp.row_version_seq;
GRANT USAGE ON SEQUENCE erp.row_version_seq TO erp_app;

-- UUIDv7 (time-ordered) for server-created rows. Devices send their own (D-036).
CREATE FUNCTION erp.uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        PLACING substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- Tenant context, set per transaction by withTenant (set_config(..., true)). NULL when not set, so RLS fails
-- closed: no rows, no writes. A malformed value raises an error.
CREATE FUNCTION erp.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION erp.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- RLS: the same forced policy on every tenant table (CLAUDE.md rule 5).
CREATE FUNCTION erp.enable_tenant_rls(tbl regclass, tenant_column text DEFAULT 'tenant_id') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %1$s USING (%2$I = erp.current_tenant_id()) WITH CHECK (%2$I = erp.current_tenant_id())',
    tbl, tenant_column);
END $$;

-- Sync: txid + row_version on every write, and no hard deletes (CLAUDE.md rule 8).
CREATE FUNCTION erp.sync_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.txid := pg_current_xact_id();
  NEW.row_version := nextval('erp.row_version_seq');
  RETURN NEW;
END $$;

CREATE FUNCTION erp.refuse_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rows in erp.% are never deleted: set deleted_at instead, so the deletion syncs', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE FUNCTION erp.enable_sync(tbl regclass, tenant_column text DEFAULT 'tenant_id') RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  table_name text := (SELECT relname FROM pg_class WHERE oid = tbl);
BEGIN
  EXECUTE format('CREATE TRIGGER sync_stamp BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION erp.sync_stamp()', tbl);
  EXECUTE format('CREATE TRIGGER refuse_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION erp.refuse_delete()', tbl);
  EXECUTE format('CREATE INDEX %I ON %s (%I, txid, row_version)', table_name || '_sync_idx', tbl, tenant_column);
END $$;

-- Audit columns, filled from the transaction's user; the client can't set or rewrite them.
CREATE FUNCTION erp.audit_stamp() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by_user_id := erp.current_user_id();
  ELSE
    NEW.created_at := OLD.created_at;
    NEW.created_by_user_id := OLD.created_by_user_id;
  END IF;
  NEW.updated_at := now();
  NEW.updated_by_user_id := erp.current_user_id();
  RETURN NEW;
END $$;

CREATE FUNCTION erp.enable_audit(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER audit_stamp BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION erp.audit_stamp()', tbl);
END $$;

-- The app role gets data access to every future table; tables that need less revoke it explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA erp GRANT USAGE ON SEQUENCES TO erp_app;
