-- 0021 Reports and support (W1-20, RPT-01…RPT-10, PLT-12, D-110). The reports read the tables that already hold the
-- facts and need no new ones; the indexes they use exist (sales_documents_day_idx, exceptions_open_idx,
-- party_ledger_entries_party_idx). New: what a counter sends with "Send diagnostics" (owner answer 6), and the
-- permission to review exceptions, given to the Manager roles made from the template (owner answer 5). Trace a bill's
-- permission (support.trace) is the owner's only, which the Owner's `*` already covers.

-- A counter's diagnostic log and health snapshot, sent by a manager (architecture §11.3). Kept 30 days, removed by the
-- worker. Not synced, and not audited row by row: the upload itself is written to the audit log (`diagnostics.sent`).
CREATE TABLE erp.device_diagnostics (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  device_id uuid NOT NULL,
  -- The manager who sent it, after their PIN on the counter.
  sent_by_user_id uuid NOT NULL,
  -- When the counter collected it (its own clock) and when the server got it.
  at_device timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  -- The health snapshot (PLT-09) and the events, oldest first: [{ at, kind, detail }].
  health jsonb NOT NULL,
  events jsonb NOT NULL CHECK (jsonb_typeof(events) = 'array'),
  event_count integer NOT NULL CHECK (event_count >= 0),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  FOREIGN KEY (tenant_id, sent_by_user_id) REFERENCES erp.users (tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX device_diagnostics_device_idx ON erp.device_diagnostics (tenant_id, device_id, received_at);
SELECT erp.enable_tenant_rls('erp.device_diagnostics');

-- Reviewing an exception (owner answer 5): its status, who and when were there from 0008; the note is new. What the
-- server recorded (kind, severity, details) never changes.
ALTER TABLE erp.exceptions ADD COLUMN review_note text CHECK (length(review_note) <= 500);

-- BEGIN exceptions-review
ALTER TABLE erp.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.roles DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE exceptions_review_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM erp.roles
  WHERE template_key = 'manager' AND NOT 'exceptions.review' = ANY (permissions);
ALTER TABLE erp.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.roles FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM exceptions_review_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.roles SET permissions = array_append(permissions, 'exceptions.review')
    WHERE template_key = 'manager' AND NOT 'exceptions.review' = ANY (permissions);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END exceptions-review
