import { postDocument } from '@erp/posting';
import pg from 'pg';

// A generated opening for a staging shop with a generated catalog (W1-14, W1-21, D-076): every priced item in Shop at
// 70% of its Retail price, 1 to 20 of each, posted like the real one, so the cost floor can be tried on staging.
// Never on production: test data never goes there.

export async function seedGeneratedOpening(
  ownerUrl: string,
  opts: { environment: string; tenantId: string; now?: Date },
): Promise<{ items: number; journal: string | null }> {
  if (opts.environment === 'prod') throw new Error('refused: test data never goes to production');
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [opts.tenantId]);
    const shop = (
      await c.query<{ id: string; branch_id: string }>(
        "SELECT id, branch_id FROM erp.locations WHERE code = 'SHOP' ORDER BY branch_id LIMIT 1",
      )
    ).rows[0];
    if (!shop) throw new Error('the shop has no SHOP location');
    // The PRD default margin (Q2) on generated categories without one, so the floors appear.
    await c.query(
      `UPDATE erp.categories SET pricing_rule = pricing_rule || '{"floor_min_margin_bp": 500}'
       WHERE NOT pricing_rule ? 'floor_min_margin_bp'`,
    );
    const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
    const opening = await c.query<{ id: string }>(
      `INSERT INTO erp.opening_balances (tenant_id, label, branch_id, as_of, business_date, legacy)
       VALUES ($1, 'generated', $2, $3, $3, '{"generated": true}') RETURNING id`,
      [opts.tenantId, shop.branch_id, today],
    );
    const id = opening.rows[0]!.id;
    // 70% of Retail, half away from zero; 1 to 20 units by item code.
    const lines = await c.query(
      `INSERT INTO erp.opening_balance_lines (tenant_id, opening_id, line_no, kind, item_id, location_id, qty, unit_cost)
       SELECT $1, $2, row_number() OVER (ORDER BY i.code), 'stock', i.id, $3, 1 + abs(hashtext(i.code)) % 20,
         round(p.price * 0.7)
       FROM erp.items i
       JOIN erp.item_prices p ON p.item_id = i.id AND p.deleted_at IS NULL
       JOIN erp.price_tiers t ON t.id = p.tier_id AND t.code = 'RETAIL'
       WHERE i.deleted_at IS NULL AND p.price > 0`,
      [opts.tenantId, id, shop.id],
    );
    const outcome = await postDocument(c, {
      tenantId: opts.tenantId,
      type: 'opening',
      id,
      now: opts.now ?? new Date(),
    });
    if (outcome.status !== 'posted') throw new Error(`the generated opening didn't post: ${outcome.status}`);
    await c.query("UPDATE erp.opening_balances SET status = 'posted', posted_at = now() WHERE id = $1", [id]);
    await c.query('COMMIT');
    return { items: lines.rowCount ?? 0, journal: outcome.journalNumber };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}
