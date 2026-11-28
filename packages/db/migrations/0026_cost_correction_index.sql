-- 0026 The cost corrections' own index (W2-09, D-124): Sales and gross profit and the dashboard read a period's
-- corrections (stock movements with no quantity). They are few, so a partial index keeps that read off the whole ledger.
CREATE INDEX stock_movements_correction_idx ON erp.stock_movements (tenant_id, business_date) WHERE qty_delta = 0;
