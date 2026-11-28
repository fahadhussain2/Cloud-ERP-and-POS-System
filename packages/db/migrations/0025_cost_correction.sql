-- 0025 Stock sold before it arrived (W2-09, D-124): stock that comes in while an item is short settles the shortfall,
-- and the difference to cost of goods sold is a stock movement of value with no quantity, on the same source and line
-- as the movement that brought the stock in. Every other movement still moves a quantity.
ALTER TABLE erp.stock_movements DROP CONSTRAINT stock_movements_qty_delta_check;
ALTER TABLE erp.stock_movements ADD CONSTRAINT stock_movements_qty_delta_check
  CHECK (qty_delta <> 0 OR (unit_cost = 0 AND value_delta <> 0));
