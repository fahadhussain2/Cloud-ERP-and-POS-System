import { TenantSpec } from '@erp/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { setupTenant } from './setup/tenant';
import { withTenant } from './tenant';
import { createTenant, createTestDatabase, type TestDatabase } from './testing/database';

// The ledger tables' own guards (migration 0009, W1-08; posting rules invariants 1, 2; CLAUDE.md rules 4, 5): every
// entry balances at commit, every line has one side, and the app role can only add ledger rows, never change them.
// Rows are written by hand here on purpose; in the app only packages/posting writes them.

let db: TestDatabase;
let pool: pg.Pool;
let owner: pg.Client;
let tenant: string;
let other: string;
let branch: string;
let cashInTransit: string;
let sales: string;
let seq = 0;

const app = <T>(fn: (c: pg.ClientBase) => Promise<T>, tenantId = tenant) =>
  withTenant(pool, { tenantId }, (_db, c) => fn(c));

/** A `postings` row and its journal entry; returns the entry's id. */
async function entry(c: pg.ClientBase, tenantId = tenant): Promise<string> {
  seq += 1;
  const source = (await c.query<{ id: string }>('SELECT erp.uuid_v7() AS id')).rows[0]!.id;
  await c.query(
    `INSERT INTO erp.postings (tenant_id, seq, source_type, source_id, posted_at, entry_date, context)
     VALUES ($1, $2, 'sale', $3, now(), '2026-11-02', '{}')`,
    [tenantId, seq, source],
  );
  const r = await c.query<{ id: string }>(
    `INSERT INTO erp.journal_entries (tenant_id, number, entry_date, source_type, source_id, memo, posting_seq,
       posted_at)
     VALUES ($1, $2, '2026-11-02', 'sale', $3, 'C03-S000001', $4, now()) RETURNING id`,
    [tenantId, `J${String(seq).padStart(6, '0')}`, source, seq],
  );
  return r.rows[0]!.id;
}

const line = (
  c: pg.ClientBase,
  entryId: string,
  lineNo: number,
  account: string,
  debit: number,
  credit: number,
) =>
  c.query(
    `INSERT INTO erp.journal_lines (tenant_id, entry_id, line_no, account_id, branch_id, debit, credit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenant, entryId, lineNo, account, branch, debit, credit],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 3 });
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  tenant = (
    await setupTenant(db.ownerUrl, TenantSpec.parse(deluxSpec), {
      ownerPasswordHash: 'x',
      mustChangePassword: false,
    })
  ).tenantId;
  other = await createTenant(db.ownerUrl, 'Other Shop', 'other');
  await app(async (c) => {
    branch = (await c.query<{ id: string }>('SELECT id FROM erp.branches')).rows[0]!.id;
    const accounts = await c.query<{ id: string; code: string }>(
      "SELECT id, code FROM erp.accounts WHERE code IN ('1120', '4100')",
    );
    cashInTransit = accounts.rows.find((a) => a.code === '1120')!.id;
    sales = accounts.rows.find((a) => a.code === '4100')!.id;
  });
});

afterAll(async () => {
  await owner?.end();
  await pool?.end();
  await db?.drop();
});

describe('journal entries balance (posting rules §1.4)', () => {
  it('accepts a balanced entry', async () => {
    await app(async (c) => {
      const e = await entry(c);
      await line(c, e, 1, cashInTransit, 435000, 0);
      await line(c, e, 2, sales, 0, 435000);
    });
    expect(await app(async (c) => (await c.query('SELECT 1 FROM erp.journal_lines')).rowCount)).toBe(2);
  });

  it('refuses an entry whose debits and credits differ, at commit', async () => {
    await expect(
      app(async (c) => {
        const e = await entry(c);
        await line(c, e, 1, cashInTransit, 435000, 0);
        await line(c, e, 2, sales, 0, 430000);
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('refuses a line with both sides, a line with neither, and a negative amount', async () => {
    for (const [debit, credit] of [
      [100, 100],
      [0, 0],
      [-100, 0],
    ] as const)
      await expect(
        app(async (c) => {
          const e = await entry(c);
          await line(c, e, 1, cashInTransit, debit, credit);
        }),
      ).rejects.toThrow(/journal_lines/);
  });
});

describe('ledgers are append-only for the app (rule 4)', () => {
  for (const table of ['postings', 'journal_entries', 'journal_lines']) {
    it(`refuses to update or delete ${table}`, async () => {
      await expect(app((c) => c.query(`UPDATE erp.${table} SET tenant_id = tenant_id`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(app((c) => c.query(`DELETE FROM erp.${table}`))).rejects.toThrow(/permission denied/);
    });
  }

  for (const table of ['stock_movements', 'party_ledger_entries'])
    it(`refuses to update or delete ${table}`, async () => {
      await expect(app((c) => c.query(`UPDATE erp.${table} SET tenant_id = tenant_id`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(app((c) => c.query(`DELETE FROM erp.${table}`))).rejects.toThrow(/permission denied/);
    });

  it('lets the app update the balances it derives', async () => {
    for (const table of ['stock_balances', 'party_balances', 'item_costs', 'posting_state'])
      await expect(
        app((c) => c.query(`UPDATE erp.${table} SET tenant_id = tenant_id`)),
      ).resolves.toBeDefined();
  });
});

describe('tenancy (rule 5)', () => {
  it('keeps one tenant’s ledgers out of another’s', async () => {
    for (const table of [
      'postings',
      'journal_entries',
      'journal_lines',
      'stock_movements',
      'stock_balances',
      'item_costs',
      'party_ledger_entries',
      'party_balances',
      'posting_state',
    ])
      expect(
        await app(async (c) => (await c.query(`SELECT 1 FROM erp.${table}`)).rowCount, other),
        table,
      ).toBe(0);
  });

  it('has forced row-level security on every ledger table', async () => {
    const { rows } = await owner.query<{ relname: string; on: boolean; forced: boolean }>(
      `SELECT relname, relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class
       WHERE relnamespace = 'erp'::regnamespace AND relname = ANY ($1) ORDER BY relname`,
      [
        [
          'item_costs',
          'journal_entries',
          'journal_lines',
          'party_balances',
          'party_ledger_entries',
          'posting_state',
          'postings',
          'stock_balances',
          'stock_movements',
        ],
      ],
    );
    expect(rows).toHaveLength(9);
    for (const r of rows) expect([r.relname, r.on, r.forced]).toEqual([r.relname, true, true]);
  });
});
