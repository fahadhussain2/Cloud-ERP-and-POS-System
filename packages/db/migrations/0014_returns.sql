-- 0014 Return and exchange (W1-13; POS-12; data model §5; posting rules §4.2, §4.3; sync spec §6.1, §6.2; POS spec §19;
-- D-005, D-006, D-051, D-100). A return or exchange is a sale document with negative lines (version 2 of the
-- document): what each returned line returns and why, which bill the return is of (or that it has no receipt), the
-- tenant's return window, the approval for a refund by transfer (owner answer 1), and the return exceptions.
-- No legacy bills (owner answer 4): a part bought before go-live is a return without a receipt.

-- The original bill (from the document, set once at push). No foreign key: a return is stored even when its bill
-- isn't on the server (rule 7); that is flagged `return_original_invalid`.
ALTER TABLE erp.sales_documents
  ADD COLUMN return_of_id uuid,
  ADD COLUMN return_of_number text,
  ADD COLUMN no_receipt boolean NOT NULL DEFAULT false,
  ADD COLUMN no_receipt_ref text,
  ADD CHECK (NOT (no_receipt AND return_of_id IS NOT NULL)),
  ADD CHECK (no_receipt OR no_receipt_ref IS NULL);
CREATE INDEX sales_documents_return_of_idx ON erp.sales_documents (tenant_id, return_of_id)
  WHERE return_of_id IS NOT NULL;

-- A returned line (qty < 0): the line it returns (null without a receipt, or when the original isn't here), its reason
-- and condition. A defective line goes to the branch's DAMAGED location (D-008).
ALTER TABLE erp.sales_lines
  ADD COLUMN original_line_id uuid,
  ADD COLUMN return_reason_code text CHECK (return_reason_code IN ('wrong_part', 'unused_option', 'defective',
    'changed_mind', 'other')),
  ADD COLUMN return_condition text CHECK (return_condition IN ('resellable', 'defective')),
  ADD COLUMN return_note text,
  ADD FOREIGN KEY (tenant_id, original_line_id) REFERENCES erp.sales_lines (tenant_id, id),
  ADD CHECK ((qty < 0) = (return_reason_code IS NOT NULL)),
  ADD CHECK ((qty < 0) = (return_condition IS NOT NULL)),
  ADD CHECK (qty < 0 OR original_line_id IS NULL),
  ADD CHECK (return_reason_code <> 'other' OR return_note IS NOT NULL);
CREATE INDEX sales_lines_original_idx ON erp.sales_lines (tenant_id, original_line_id)
  WHERE original_line_id IS NOT NULL;

-- The tenant's return window (PRD Q3: 30 days); a category's `return_policy` may set its own.
ALTER TABLE erp.tenants ADD COLUMN return_window_days integer NOT NULL DEFAULT 30
  CHECK (return_window_days BETWEEN 0 AND 3650);

-- A refund by transfer is approved by a manager (owner answer 1).
ALTER TABLE erp.overrides DROP CONSTRAINT overrides_kind_check;
ALTER TABLE erp.overrides ADD CONSTRAINT overrides_kind_check CHECK (kind IN ('below_list', 'below_floor',
  'credit_limit', 'offline_cap', 'no_receipt_return', 'return_permission', 'return_outside_policy', 'void', 'reprint',
  'refund_transfer'));

ALTER TABLE erp.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE erp.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('below_floor_no_override',
  'discount_over_limit', 'document_inconsistent', 'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock',
  'missing_handover', 'handover_amount_mismatch', 'cash_received_for_void', 'seq_gap', 'clock_skew',
  'revoked_device_doc', 'bad_signature', 'no_cost', 'posting_failed', 'posted_after_lock', 'duplicate_handover',
  'handover_not_permitted', 'cash_not_permitted', 'float_mismatch', 'void_not_permitted', 'duplicate_void',
  'return_over_quantity', 'return_original_invalid', 'return_price_mismatch', 'return_not_permitted'));
