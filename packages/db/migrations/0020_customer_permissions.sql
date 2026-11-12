-- 0020 Customers in the back office (W1-22, D-109). No table changes: a customer is a party with a live customer
-- account (0006), pulled by the counters since 0010. Only the permissions: cust.edit (add and edit customers) goes to
-- the Manager and Accountant roles made from the templates, as the templates now have it (owner answer 1);
-- cust.terms.edit (tier and credit terms) is the owner's only (owner answer 2), and the Owner's `*` covers it.

-- BEGIN customer-edit
ALTER TABLE erp.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.roles DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE customer_edit_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM erp.roles
  WHERE template_key IN ('manager', 'accountant') AND NOT 'cust.edit' = ANY (permissions);
ALTER TABLE erp.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.roles FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM customer_edit_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.roles SET permissions = array_append(permissions, 'cust.edit')
    WHERE template_key IN ('manager', 'accountant') AND NOT 'cust.edit' = ANY (permissions);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END customer-edit
