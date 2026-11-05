-- W1-15 catalog maintenance (CAT-07, data model §4): every price change, who made it, when and why.

CREATE TABLE erp.price_history (
  id uuid PRIMARY KEY DEFAULT erp.uuid_v7(),
  tenant_id uuid NOT NULL REFERENCES erp.tenants (id),
  item_id uuid NOT NULL,
  -- The tier whose price changed; NULL = the item's own floor (items.floor_price).
  tier_id uuid,
  -- Minor units; NULL = no price (a tier without one, or no own floor).
  old_value bigint,
  new_value bigint,
  source text NOT NULL CHECK (source IN ('manual', 'import', 'repricing')),
  -- Why a price went down (owner answer 2 to W1-15); NULL when nobody had to say.
  reason_code text CHECK (reason_code IN ('supplier_price', 'market_price', 'slow_stock', 'correction', 'other')),
  note text,
  user_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, item_id) REFERENCES erp.items (tenant_id, id),
  FOREIGN KEY (tenant_id, tier_id) REFERENCES erp.price_tiers (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES erp.users (tenant_id, id)
);
CREATE INDEX price_history_item_idx ON erp.price_history (tenant_id, item_id, at DESC);
SELECT erp.enable_tenant_rls('erp.price_history');
-- A history is only added to (CAT-07).
REVOKE UPDATE, DELETE ON erp.price_history FROM erp_app;

-- BEGIN manager-price
-- Only the owner changes prices (owner answer 3 to W1-15): the Manager roles made from the template lose
-- cat.price.edit, as the template did. A role made by hand (no template_key) is left as it is. As in 0012 and 0013,
-- each tenant in its own context, since the migration role is under the forced RLS and the change is audited per
-- tenant; RLS is lifted only to read which tenants have such a role.
ALTER TABLE erp.roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE erp.roles DISABLE ROW LEVEL SECURITY;
CREATE TEMPORARY TABLE manager_price_tenants ON COMMIT DROP AS
  SELECT DISTINCT tenant_id FROM erp.roles WHERE template_key = 'manager' AND 'cat.price.edit' = ANY (permissions);
ALTER TABLE erp.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.roles FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM manager_price_tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE erp.roles SET permissions = array_remove(permissions, 'cat.price.edit')
    WHERE template_key = 'manager' AND 'cat.price.edit' = ANY (permissions);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
-- END manager-price
