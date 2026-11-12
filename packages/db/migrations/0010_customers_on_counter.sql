-- Customers on the counter (W1-09, sync spec §3, D-096): the counter pulls parties with a live customer account,
-- their accounts and their balances.

-- The `customers` pull returns only parties with a live customer account, by its cursor on `parties`. A party whose
-- account arrives (or comes back, or moves to it) after the party's own row was pulled is touched, so the row gets a
-- new txid and the next pull sends it. The touch changes no data, so the audit log skips it.
CREATE FUNCTION erp.touch_customer_party() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) OR OLD.party_id <> NEW.party_id THEN
    UPDATE erp.parties SET updated_at = now() WHERE tenant_id = NEW.tenant_id AND id = NEW.party_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER touch_customer_party AFTER INSERT OR UPDATE ON erp.customer_accounts
  FOR EACH ROW EXECUTE FUNCTION erp.touch_customer_party();

-- The SSE nudge (sync spec §8) for the three newly pulled tables.
SELECT erp.enable_sync_notify(t) FROM unnest(ARRAY['erp.parties', 'erp.customer_accounts', 'erp.party_balances']::regclass[]) AS t;
