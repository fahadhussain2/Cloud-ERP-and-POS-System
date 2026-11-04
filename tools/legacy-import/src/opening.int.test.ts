import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { checkRebuild, postDocument } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import mappingFile from '../golden/transform/mapping.json';
import { importOpening, type OpeningOptions, type OpeningResult } from './opening-load';
import { writeOpeningReports } from './opening-reports';
import { parseMapping } from './transform/mapping';

// The opening balances from a staged dump (W1-14, MIG-02, MIG-04): a draft, replaced on a re-run, posted once, never
// changed after, reconciled from the ledgers, rebuildable, and the cost floor for the counters. On synthetic staged
// rows: no real data in git or CI.

let app: TestDatabase;
let admin: pg.Client;
let pool: pg.Pool;
let stagingDb: string;
let stagingUrl: string;
let tenantId: string;
let outDir: string;
let items: Record<string, string>;

const mapping = parseMapping({
  ...mappingFile,
  opening: {
    docTypes: {
      '3': { name: 'Purchase', sign: 1 },
      '4': { name: 'Purchase return', sign: -1 },
      '5': { name: 'Sale', sign: -1 },
      '6': { name: 'Sale return', sign: 1 },
      '8': { name: 'Stock in', sign: 1 },
      '9': { name: 'Stock out', sign: -1 },
    },
    customerAccount: '10-03-0001',
    supplierAccount: '20-02-0001',
    itemOpeningQuantity: true,
  },
});

/** Creates a staged table: every column text, plus the stage step's `_file` and `_line`. */
async function table(
  c: pg.Client,
  schema: string,
  name: string,
  columns: string[],
  rows: (string | null)[][],
) {
  await c.query(
    `CREATE TABLE "${schema}".${name} (${[...columns, '_file', '_line'].map((col) => `${col} text`).join(', ')})`,
  );
  for (const [i, r] of rows.entries())
    await c.query(
      `INSERT INTO "${schema}".${name} VALUES (${[...r, 'f.sql', String(i + 1)].map((_, j) => `$${j + 1}`).join(', ')})`,
      [...r, 'f.sql', String(i + 1)],
    );
}

/** A synthetic dump: three items, one sold out and sold recently, one negative; two customers, a supplier. */
async function stage(label: string, extraSale = false) {
  const schema = `legacy_${label}`;
  const c = new pg.Client({ connectionString: stagingUrl });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await c.query(`CREATE SCHEMA "${schema}"`);
    await table(
      c,
      schema,
      'inv_item',
      ['itemid', 'openingquantity', 'costprice', 'openingrate', 'saleprice'],
      [
        ['ABEA001', '10.00', '900.00', '0.00', '1250.00'],
        ['ABEA002', '0.00', '0.00', '0.00', '0.00'],
        ['BBCD001', '1.00', '500.00', '0.00', '450.00'],
      ],
    );
    const header = [
      'companyid',
      'periodid',
      'transactionid',
      'documenttypeid',
      'documentdate',
      'bpsubaccountcode',
    ];
    const detail = ['companyid', 'periodid', 'transactionid', 'itemid', 'quantity', 'rate'];
    await table(c, schema, 'inv_purchaseheader', header, [
      ['1', '1', '1', '3', '2026-11-02 10:00:00.000', '0210'],
      ['1', '1', '2', '4', '2026-11-03 10:00:00.000', '0210'],
    ]);
    await table(c, schema, 'inv_purchasedetail', detail, [
      ['1', '1', '1', 'ABEA001', '5.00', '1000.00'],
      ['1', '1', '1', 'ABEA002', '2.00', '300.00'],
      ['1', '1', '2', 'ABEA001', '1.00', '1000.00'],
    ]);
    await table(c, schema, 'inv_saleheader', header, [
      ['1', '1', '1', '5', '2026-11-20 12:00:00.000', '0002'],
      ['1', '1', '2', '5', '2026-11-25 12:00:00.000', '0150'],
      ...(extraSale ? [['1', '1', '3', '5', '2026-11-26 12:00:00.000', '0002']] : []),
    ]);
    await table(c, schema, 'inv_saledetail', detail, [
      ['1', '1', '1', 'ABEA002', '2.00', '450.00'],
      ['1', '1', '2', 'BBCD001', '4.00', '450.00'],
      ['1', '1', '2', 'ABEA001', '1.00', '1250.00'],
      ...(extraSale ? [['1', '1', '3', 'ABEA001', '1.00', '1250.00']] : []),
    ]);
    await table(c, schema, 'inv_physicalstockheader', header.slice(0, 5), []);
    await table(c, schema, 'inv_physicalstockdetail', detail, []);
    await table(
      c,
      schema,
      'inv_stockrecordtab',
      ['itemid', 'documenttypeid', 'documentdate', 'transactionid', 'stockquantity', 'valuationrate'],
      [
        ['ABEA001', '3', '2026-11-02 10:00:00.000', '1', '15.00', '933.3333'],
        ['ABEA001', '5', '2026-11-25 12:00:00.000', '2', '13.00', '933.3333'],
        ['BBCD001', '5', '2026-11-25 12:00:00.000', '2', '-3.00', null],
      ],
    );
    await table(
      c,
      schema,
      'gl_transactionheader',
      ['companyid', 'periodid', 'transactionid', 'documentdate'],
      [
        ['1', '1', '1', '2026-07-01 00:00:00.000'],
        ['1', '1', '2', '2026-11-25 12:00:00.000'],
      ],
    );
    await table(
      c,
      schema,
      'gl_transactiondetail',
      ['companyid', 'periodid', 'transactionid', 'accountcode', 'subaccountcode', 'amountdr', 'amountcr'],
      [
        ['1', '1', '1', '10-03-0001', '0150', '5000.00', '0.00'],
        ['1', '1', '1', '20-02-0001', '0210', '0.00', '12000.00'],
        ['1', '1', '1', '50-01-0001', null, '7000.00', '0.00'],
        ['1', '1', '2', '10-03-0001', '0151', '0.00', '200.00'],
        ['1', '1', '2', '10-03-0001', '0002', '300.00', '0.00'],
      ],
    );
    await table(
      c,
      schema,
      'gen_doctype',
      ['documenttypeid', 'documenttype'],
      [
        ['3', 'Purchase'],
        ['5', 'Sale'],
      ],
    );
  } finally {
    await c.end();
  }
}

const options = (over: Partial<OpeningOptions> = {}): OpeningOptions => ({
  stagingUrl,
  label: 'fixture',
  appUrl: app.appUrl,
  tenantCode: 'delux',
  mapping,
  asOf: '2026-11-30',
  businessDate: '2026-11-30',
  write: true,
  post: false,
  inputs: {},
  legacyTotals: null,
  now: new Date('2026-11-30T20:00:00Z'),
  ...over,
});

const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql, params)).rows;

beforeAll(async () => {
  app = await createTestDatabase();
  admin = new pg.Client({ connectionString: app.adminUrl });
  await admin.connect();
  pool = new pg.Pool({ connectionString: app.appUrl, max: 2 });
  const report = await setupTenant(app.ownerUrl, TenantSpec.parse(deluxSpec), {
    ownerPasswordHash: 'x',
    mustChangePassword: true,
  });
  tenantId = report.tenantId;
  items = await withTenant(pool, { tenantId }, async (_db, c) => {
    const ids = await seedCatalog(c, tenantId, [
      { code: 'ABEA001', name: 'OIL FILTER', category: 'ABEA', prices: { RETAIL: 125000 } },
      { code: 'ABEA002', name: 'BRAKE PAD', category: 'ABEA', prices: { RETAIL: 45000 } },
      { code: 'BBCD001', name: 'FILTER', category: 'BBCD', prices: { RETAIL: 45000 }, floor: 47000 },
    ]);
    await c.query(
      `UPDATE erp.categories SET pricing_rule = '{"floor_min_margin_bp": 500}' WHERE code = 'ABEA'`,
    );
    for (const [code, name] of [
      ['0150', 'KHAN MECHANIC'],
      ['0151', 'ALI AUTOS'],
      ['0210', 'ADDI TRADERS'],
    ])
      await c.query('INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, $2, $3)', [
        tenantId,
        code,
        name,
      ]);
    return ids;
  });
  const base = process.env['DATABASE_URL']!;
  stagingDb = `legacy_test_${randomBytes(6).toString('hex')}`;
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  await c.query(`CREATE DATABASE ${stagingDb}`);
  await c.end();
  const u = new URL(base);
  u.pathname = `/${stagingDb}`;
  stagingUrl = u.toString();
  outDir = await mkdtemp(join(tmpdir(), 'legacy-opening-'));
  await stage('fixture');
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  await app?.drop();
  const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${stagingDb} WITH (FORCE)`);
  await c.end();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe('an opening from a staged dump', () => {
  let draft: OpeningResult;
  let posted: OpeningResult;

  it('stops on a document type without a sign, before writing anything', async () => {
    const m = parseMapping({
      ...mappingFile,
      opening: {
        docTypes: { '3': { name: 'Purchase', sign: 1 } },
        customerAccount: '10-03-0001',
        supplierAccount: '20-02-0001',
        itemOpeningQuantity: true,
      },
    });
    await expect(importOpening(options({ mapping: m }))).rejects.toThrow(/document types without a sign/);
    expect(await q('SELECT 1 FROM erp.opening_balances')).toEqual([]);
  });

  it('computes without writing on a dry run', async () => {
    const r = await importOpening(options({ write: false }));
    expect(r.status).toBe('computed');
    expect(await q('SELECT 1 FROM erp.opening_balances')).toEqual([]);
  });

  it('writes a draft: stock in Shop at the legacy cost, the customers and the supplier', async () => {
    draft = await importOpening(options());
    expect(draft.status).toBe('draft');
    // ABEA001: 10 + 5 − 1 (purchase return) − 1 (sale) = 13 at 933.33; ABEA002: 0 + 2 − 2 = 0 (left out, but sold
    // recently); BBCD001: 1 − 4 = −3 at the cost price 500.
    expect(draft.totals).toEqual({
      items: 3,
      stockLines: 2,
      stockQty: 10000,
      stockValue: 13 * 93333 - 3 * 50000,
      noCost: 0,
      customers: 2,
      customerTotal: 500000 - 20000,
      suppliers: 1,
      supplierTotal: 1200000,
    });
    expect(draft.detail.negative).toEqual([{ code: 'BBCD001', qty: -3000 }]);
    expect(draft.detail.zeroWithSales).toEqual([{ code: 'ABEA002', sold: 1 }]);
    expect(draft.detail.qtyMismatch).toEqual([]);
    expect(draft.detail.excluded).toEqual([{ role: 'customer', code: '0002', amount: 30000 }]);
    expect(draft.detail.costAboveRetail).toEqual([{ code: 'BBCD001', cost: 50000, retail: 45000 }]);
    const lines = await q<{
      kind: string;
      qty: string | null;
      unit_cost: string | null;
      amount: string | null;
    }>(
      'SELECT kind, qty::text, unit_cost::text, amount::text FROM erp.opening_balance_lines ORDER BY line_no',
    );
    expect(lines).toEqual([
      { kind: 'stock', qty: '13.000', unit_cost: '93333', amount: null },
      { kind: 'stock', qty: '-3.000', unit_cost: '50000', amount: null },
      { kind: 'customer', qty: null, unit_cost: null, amount: '500000' },
      { kind: 'customer', qty: null, unit_cost: null, amount: '-20000' },
      { kind: 'supplier', qty: null, unit_cost: null, amount: '1200000' },
    ]);
    expect(await q('SELECT 1 FROM erp.postings')).toEqual([]);
  });

  it('replaces the draft on a re-run with changed figures', async () => {
    await stage('fixture', true);
    const again = await importOpening(options());
    expect(again.status).toBe('draft');
    expect(again.totals.stockQty).toBe(9000);
    expect(await q('SELECT count(*)::int AS n FROM erp.opening_balances')).toEqual([{ n: 1 }]);
    await stage('fixture');
    await importOpening(options());
  });

  it('posts once: the ledgers, the last purchase, the floors and the reconciliation from the ledgers', async () => {
    posted = await importOpening(
      options({
        post: true,
        inputs: { accounts: { '1110': '5000', '1160': '250000.50' } },
        legacyTotals: {
          closingStockQty: '10',
          customerOutstanding: '4800.00',
          supplierOutstanding: '12001.00',
        },
      }),
    );
    expect(posted.status).toBe('posted');
    const status = await q<{ status: string }>('SELECT status FROM erp.opening_balances');
    expect(status).toEqual([{ status: 'posted' }]);
    const costs = await q<{ code: string; avg_cost: string; on_hand: string; last_cost: string | null }>(
      `SELECT i.code, k.avg_cost::text, k.on_hand::text, k.last_cost::text FROM erp.item_costs k
       JOIN erp.items i ON i.id = k.item_id ORDER BY i.code`,
    );
    expect(costs).toEqual([
      { code: 'ABEA001', avg_cost: '93333', on_hand: '13.000', last_cost: '100000' },
      { code: 'BBCD001', avg_cost: '50000', on_hand: '-3.000', last_cost: null },
    ]);
    // ABEA has a 5% margin: 93,333 × 1.05 = 97,999.65 → 98,000. BBCD has no margin: no cost floor (its explicit
    // floor stays on the item).
    const floors = await q<{ item_id: string; floor: string }>(
      'SELECT item_id, floor::text FROM erp.item_floors WHERE deleted_at IS NULL',
    );
    expect(floors).toEqual([{ item_id: items['ABEA001'], floor: '98000' }]);
    const tb = posted.detail.openingTrialBalance;
    const dr = tb.reduce((s, l) => s + l.debit, 0);
    const cr = tb.reduce((s, l) => s + l.credit, 0);
    expect(dr).toBe(cr);
    expect(tb.find((l) => l.account === '1110')).toEqual({ account: '1110', debit: 500000, credit: 0 });
    expect(tb.find((l) => l.account === '1160')).toEqual({ account: '1160', debit: 25000050, credit: 0 });
    const byCheck = Object.fromEntries(posted.checks.map((c) => [c.check, c.status]));
    expect(byCheck).toMatchObject({
      'Stock quantity (ledger) = legacy computation': 'pass',
      'Stock value (ledger) = legacy computation (Rs 1 per item)': 'pass',
      'Customers (ledger) = legacy GL': 'pass',
      'Suppliers (ledger) = legacy GL': 'pass',
      'Opening entry balances (Dr = Cr)': 'pass',
      'Stock quantity = legacy Closing Stock report': 'pass',
      'Stock value = legacy Closing Stock report (Rs 1 per item)': 'waiting',
      'Customers = legacy Customer Outstanding': 'pass',
      'Suppliers = legacy Supplier Outstanding': 'differs',
    });
    const audit = await q<{ action: string }>(
      "SELECT action FROM erp.audit_log WHERE action = 'opening.posted'",
    );
    expect(audit).toHaveLength(1);
  });

  it('is rebuildable: the rebuild check finds no difference', async () => {
    expect((await checkRebuild(pool, tenantId)).differences).toEqual([]);
  });

  it('changes nothing on a re-run after posting, and lists what differs', async () => {
    await stage('fixture', true);
    const again = await importOpening(options({ post: true }));
    expect(again.status).toBe('unchanged');
    expect(again.differences).toBeGreaterThan(0);
    expect(await q('SELECT count(*)::int AS n FROM erp.postings')).toEqual([{ n: 1 }]);
    await stage('fixture');
  });

  it('refuses to change or delete a posted opening as the app role, and never posts it twice', async () => {
    await expect(
      withTenant(pool, { tenantId }, (_db, c) => c.query("UPDATE erp.opening_balances SET label = 'other'")),
    ).rejects.toThrow(/is posted/);
    await expect(
      withTenant(pool, { tenantId }, (_db, c) => c.query('DELETE FROM erp.opening_balance_lines')),
    ).rejects.toThrow(/is posted/);
    const id = (await q<{ id: string }>('SELECT id FROM erp.opening_balances'))[0]!.id;
    const outcome = await withTenant(pool, { tenantId }, (_db, c) =>
      postDocument(c, { tenantId, type: 'opening', id, now: new Date() }),
    );
    expect(outcome).toEqual({ status: 'already_posted' });
  });

  it('writes the reconciliation page and the reports', async () => {
    const page = await writeOpeningReports(posted, outDir);
    const text = await readFile(page, 'utf8');
    expect(text).toContain('Opening balances: fixture (posted)');
    expect(text).toContain('differs');
    const files = await readdir(join(outDir, 'reports', 'opening'), { recursive: true });
    expect(files).toEqual(
      expect.arrayContaining([
        'doc-types.csv',
        'negative-stock.csv',
        'zero-stock-recent-sales.csv',
        'quantity-mismatch.csv',
        'summary.json',
        join('parties', 'top-customers.csv'),
      ]),
    );
    const summary = await readFile(join(outDir, 'reports', 'opening', 'summary.json'), 'utf8');
    expect(summary).not.toMatch(/KHAN|ALI AUTOS|ADDI/);
  });
});
