-- 0022 Voids and returns by payment; cash taken for a voided bill given back (W1-23, CSH-04, CSH-07, CSH-08, POS-11,
-- D-111). A void now records what the counter knew of each payment part (SaleVoidV2); a desk gives back the cash it
-- took for a voided bill as a cash movement of kind void_cash (CashMovementV2), with the approver's PIN; the queue
-- carries a return's original (guard 2), the bill's void and the movement that gave its cash back.

-- The void's payment checks (V2): [{ method, amount, known, answer }]; null for a W1-12 (V1) void.
ALTER TABLE erp.sales_voids
  ADD COLUMN payment_checks jsonb CHECK (payment_checks IS NULL OR jsonb_typeof(payment_checks) = 'array');

-- Cash given back for a voided bill: the bill it is for, who approved it (never the session's cashier, owner answer
-- 1), and the first one it repeats (a second give-back of a bill is kept, flagged and never posted). No foreign keys:
-- a give-back is stored even when its bill isn't on the server yet (rule 7).
ALTER TABLE erp.cash_movements DROP CONSTRAINT cash_movements_kind_check;
ALTER TABLE erp.cash_movements ADD CONSTRAINT cash_movements_kind_check
  CHECK (kind IN ('expense', 'supplier_payment', 'bank_deposit', 'to_safe', 'from_safe', 'void_cash'));
ALTER TABLE erp.cash_movements
  ADD COLUMN bill_number text,
  ADD COLUMN approved_by_user_id uuid,
  ADD COLUMN duplicate_of_id uuid,
  ADD CHECK ((kind = 'void_cash') = (bill_number IS NOT NULL)),
  ADD CHECK ((kind = 'void_cash') = (approved_by_user_id IS NOT NULL)),
  ADD CHECK (kind = 'void_cash' OR duplicate_of_id IS NULL);
CREATE INDEX cash_movements_void_cash_idx ON erp.cash_movements (tenant_id, bill_number)
  WHERE kind = 'void_cash';

-- What the desk's queue needs (sync spec §3): the void's number, and the movement that gave the bill's cash back. A
-- voided bill whose cash the desk took stays in the queue until it is given back.
ALTER TABLE erp.sales_documents
  ADD COLUMN void_number text,
  ADD COLUMN cash_given_back_number text;
UPDATE erp.sales_documents d SET void_number = v.number
FROM erp.sales_voids v
WHERE v.tenant_id = d.tenant_id AND v.id = d.void_document_id AND d.void_number IS NULL;

ALTER TABLE erp.exceptions DROP CONSTRAINT exceptions_kind_check;
ALTER TABLE erp.exceptions ADD CONSTRAINT exceptions_kind_check CHECK (kind IN ('below_floor_no_override',
  'discount_over_limit', 'document_inconsistent', 'credit_limit_exceeded', 'offline_cap_exceeded', 'negative_stock',
  'missing_handover', 'handover_amount_mismatch', 'cash_received_for_void', 'seq_gap', 'clock_skew',
  'revoked_device_doc', 'bad_signature', 'no_cost', 'posting_failed', 'posted_after_lock', 'duplicate_handover',
  'handover_not_permitted', 'cash_not_permitted', 'float_mismatch', 'void_not_permitted', 'duplicate_void',
  'return_over_quantity', 'return_original_invalid', 'return_price_mismatch', 'return_not_permitted',
  'refund_before_payment', 'void_cash_duplicate', 'void_cash_not_voided', 'void_cash_without_handover',
  'void_cash_amount_mismatch'));
