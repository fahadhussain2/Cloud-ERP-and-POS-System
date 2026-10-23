-- Runs once, when the database is first created (W0-05, D-076).
-- Backup canary: the server adds a row every minute. It keeps WAL flowing, so the archive age is a real
-- health signal, and every restore drill measures the real RPO from the newest restored row.
-- A system table, not tenant data (no tenant_id, no RLS; allow-listed in the W0-07 RLS test).
CREATE SCHEMA ops;
CREATE TABLE ops.backup_canary (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
