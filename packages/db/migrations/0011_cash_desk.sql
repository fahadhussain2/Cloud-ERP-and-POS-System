-- 0011 Cash desk 1 (W1-10; CSH-01…CSH-04; data model §6; sync spec §3, §6.2, §8; cash desk spec). Cash sessions and
-- handovers as the desks push them (rules 3, 7), the cash queue a desk pulls, and the nudge that tells only the
-- branch's desks about it.

-- What the queue shows of a bill (PRD W4.1): the salesman's cash received and the change, set once by push from the
-- cash payment. The bill is still never changed after that (rule 3).
ALTER TABLE erp.sales_documents
  ADD COLUMN cash_received bigint CHECK (cash_received >= 0),
  ADD COLUMN change_due bigint CHECK (change_due >= 0);
UPDATE erp.sales_documents d SET cash_received = p.cash_received, change_due = p.change_due
FROM erp.sales_payments p JOIN erp.payment_methods m ON m.tenant_id = p.tenant_id AND m.id = p.method_id
WHERE p.tenant_id = d.tenant_id AND p.document_id = d.id AND m.code = 'cash';
-- The desk's queue reads a branch's bills with cash to move (sync spec §3).
CREATE INDEX sales_documents_cash_queue_idx ON erp.sales_documents (tenant_id, branch_id, txid, row_version)
  WHERE cash_due <> 0;

-- A cash desk's session (CSH-01): opened with a float by one cashier, closed by anyone with cash.session.close (owner
-- answer 1 to W1-10). `id` is the open document's id. The close fields are set by the close document (audited).
CREATE TABLE erp.cash_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  number text NOT NULL,
  cashier_user_id uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  business_date date NOT NULL,
  opening_float bigint NOT NULL CHECK (opening_float >= 0),
  closed_at timestamptz,
  closed_by_user_id uuid,
  close_document_id uuid,
  close_number text,
  -- The desk's figure at close (float + handovers − payouts); the count and the variance come with W1-11.
  expected_cash bigint,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- The open and close documents exactly as the desk signed them (D-082).
  payload jsonb NOT NULL,
  signature bytea NOT NULL,
  close_payload jsonb,
  close_signature bytea,
  client_version text NOT NULL,
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by_user_id) REFERENCES erp.users (tenant_id, id),
  UNIQUE (tenant_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL AND close_payload IS NOT NULL))
);
CREATE INDEX cash_sessions_device_idx ON erp.cash_sessions (tenant_id, device_id, opened_at);
SELECT erp.enable_tenant_rls('erp.cash_sessions');
SELECT erp.enable_sync('erp.cash_sessions');
SELECT erp.enable_audit('erp.cash_sessions');
REVOKE DELETE ON erp.cash_sessions FROM erp_app;

-- A handover in or a refund payout (data model §6), as the desk made it. Matched to its bill by number, so an offline
-- scan works before the bill arrives: `sales_document_id` is linked then. A second one for a bill is kept with
-- `duplicate_of_id` and never posted. Only the link ever changes.
CREATE TABLE erp.cash_handovers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  device_id uuid NOT NULL,
  number text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  -- No foreign key: the desk pushes its session's open first, but a handover is never refused for it (rule 7).
  session_id uuid NOT NULL,
  sales_document_id uuid,
  bill_number text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('in', 'payout')),
  -- Minor units (rule 1). `amount` is the posted figure; the rest are operational records that don't post.
  amount bigint NOT NULL CHECK (amount > 0),
  received_amount bigint CHECK (received_amount >= 0),
  change_given bigint CHECK (change_given >= 0),
  corrected_from bigint CHECK (corrected_from >= 0),
  method text NOT NULL CHECK (method IN ('queue', 'scan', 'auto')),
  cashier_user_id uuid NOT NULL,
  at_device timestamptz NOT NULL,
  business_date date NOT NULL,
  received_at timestamptz NOT NULL,
  duplicate_of_id uuid,
  payload jsonb NOT NULL,
  payload_hash bytea NOT NULL,
  signature bytea NOT NULL,
  client_version text NOT NULL,
  exception_count integer NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  row_version bigint NOT NULL,
  txid xid8 NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  created_by_user_id uuid,
  updated_at timestamptz NOT NULL,
  updated_by_user_id uuid,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES erp.devices (tenant_id, id),
  FOREIGN KEY (tenant_id, cashier_user_id) REFERENCES erp.users (tenant_id, id),
  FOREIGN KEY (tenant_id, sales_document_id) REFERENCES erp.sales_documents (tenant_id, id),
  FOREIGN KEY (tenant_id, duplicate_of_id) REFERENCES erp.cash_handovers (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_id, seq)
);
-- One handover per bill and kind; a second confirmation is a duplicate (data model §6).
CREATE UNIQUE INDEX cash_handovers_one_per_bill ON erp.cash_handovers (tenant_id, bill_number, kind)
  WHERE duplicate_of_id IS NULL;
CREATE INDEX cash_handovers_session_idx ON erp.cash_handovers (tenant_id, session_id);
CREATE INDEX cash_handovers_unlinked_idx ON erp.cash_handovers (tenant_id, bill_number)
  WHERE sales_document_id IS NULL;
SELECT erp.enable_tenant_rls('erp.cash_handovers');
SELECT erp.enable_sync('erp.cash_handovers');
SELECT erp.enable_audit('erp.cash_handovers');
REVOKE DELETE ON erp.cash_handovers FROM erp_app;

-- Postings of handovers (posting rules §4.5) beside sales.
ALTER TABLE erp.postings DROP CONSTRAINT postings_source_type_check;
ALTER TABLE erp.postings ADD CONSTRAINT postings_source_type_check CHECK (source_type IN ('sale', 'cash_handover'));

ALTER TABLE erp.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE erp.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('below_floor_no_override',
  'discount_over_limit', 'document_inconsistent', 'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock',
  'missing_handover', 'handover_amount_mismatch', 'cash_received_for_void', 'seq_gap', 'clock_skew',
  'revoked_device_doc', 'bad_signature', 'no_cost', 'posting_failed', 'posted_after_lock', 'duplicate_handover',
  'handover_not_permitted'));

-- `queue-changed` (sync spec §8): a change to a bill with cash to move tells that branch's cash desks, on its own
-- channel, as '<tenant>:<branch>'. Counters don't pull the queue, so they aren't woken by every bill.
CREATE FUNCTION erp.notify_cash_queue() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target text;
BEGIN
  FOR target IN SELECT DISTINCT tenant_id::text || ':' || branch_id::text FROM changed WHERE cash_due <> 0 LOOP
    PERFORM pg_notify('erp_queue', target);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER cash_queue_notify_insert AFTER INSERT ON erp.sales_documents REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION erp.notify_cash_queue();
CREATE TRIGGER cash_queue_notify_update AFTER UPDATE ON erp.sales_documents REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION erp.notify_cash_queue();
