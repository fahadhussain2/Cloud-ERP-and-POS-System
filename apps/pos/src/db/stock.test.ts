// @vitest-environment node
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { migrate } from './migrate';
import { applyPull, setDevice, setSync } from './repo';
import { wrapOo1, type SqlDb } from './sql';
import { stockFor } from './stock';

// Stock on the counter (W1-27 plan, POS-02), on real SQLite: the pulled Shop and Godown balances, less this counter's
// own bills the balance can't include yet (owner answer 1): still in the outbox, or accepted after the start of the
// last complete pull, as for a customer's credit (POS spec §15). A voided bill gives its stock back, a resellable
// return adds to the Shop, a defective one goes to Damaged (not shown), and nothing is counted twice.

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>;
let db: SqlDb;

const ID = (n: string) => `019a0000-0000-7000-8000-0000000000${n}`;
const SHOP = ID('c1');
const GODOWN = ID('c2');
const PAD = ID('b1');
const HOSE = ID('b2');
const LAMP = ID('b3');
const row = (r: Record<string, unknown>) => ({ row_version: '1', deleted_at: null, ...r });
const PULL_START = '2026-11-15T10:00:00.000Z';

function ready() {
  setDevice(db, { deviceId: ID('d1'), tenantId: ID('f1'), branchId: ID('e1'), code: 'C03', kind: 'counter' });
  applyPull(
    db,
    {
      // The Godown first: the Shop still comes first on the counter.
      locations: [
        row({ id: GODOWN, code: 'GODOWN', name: 'Godown', kind: 'storage' }),
        row({ id: SHOP, code: 'SHOP', name: 'Shop', kind: 'shop' }),
      ],
      stock_balances: [
        row({ item_id: PAD, location_id: SHOP, qty: '8.000' }),
        row({ item_id: PAD, location_id: GODOWN, qty: '4.000' }),
        row({ item_id: HOSE, location_id: SHOP, qty: '4.500' }),
      ],
    },
    'c1',
    true,
    PULL_START,
  );
  setSync(db, 'complete_pull_started_at', PULL_START);
}

let seq = 0;
/** One of this counter's documents, as finalize and void store them; in the outbox until `acceptedAt`. */
function bill(
  family: 'S' | 'V',
  payload: Record<string, unknown>,
  acceptedAt: string | null = null,
  id = `019a3f6e-7b10-7c3a-9d2e-${String(++seq).padStart(12, '0')}`,
) {
  const text = JSON.stringify({ id, ...payload });
  db.exec(
    `INSERT INTO local_documents (id, family, seq, number, kind, business_date, payload, created_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, '2026-11-15', ?, '2026-11-15T09:00:00.000Z', ?)`,
    [id, family, seq, `A1-${seq}`, family === 'V' ? 'void' : 'sale', text, acceptedAt],
  );
  if (acceptedAt === null)
    db.exec(
      `INSERT INTO outbox (id, family, seq, payload, status, attempts, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, '2026-11-15T09:00:00.000Z')`,
      [id, family, seq, text],
    );
  return id;
}
const sold = (itemId: string, qty: number) => ({ itemId, qty });
const back = (itemId: string, qty: number, condition: 'resellable' | 'defective') => ({
  itemId,
  qty: -qty,
  condition,
});
const shop = (itemId: string) =>
  stockFor(db, [itemId])
    .get(itemId)!
    .find((s) => s.kind === 'shop')!.qty;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

beforeEach(() => {
  db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
  migrate(db);
  ready();
});

describe('the pulled balances', () => {
  it('gives each item its Shop and Godown, the Shop first, 0 where there is no balance', () => {
    const got = stockFor(db, [PAD, HOSE, LAMP]);
    expect(got.get(PAD)).toEqual([
      { locationId: SHOP, name: 'Shop', kind: 'shop', qty: 8000 },
      { locationId: GODOWN, name: 'Godown', kind: 'storage', qty: 4000 },
    ]);
    expect(got.get(HOSE)!.map((s) => s.qty)).toEqual([4500, 0]);
    expect(got.get(LAMP)!.map((s) => s.qty)).toEqual([0, 0]);
  });

  it('a later pull replaces a balance by item and location, and a removed one goes', () => {
    applyPull(
      db,
      { stock_balances: [row({ item_id: PAD, location_id: SHOP, qty: '5.000', row_version: '2' })] },
      'c2',
    );
    expect(
      stockFor(db, [PAD])
        .get(PAD)!
        .map((s) => s.qty),
    ).toEqual([5000, 4000]);
    applyPull(
      db,
      {
        stock_balances: [
          row({ item_id: PAD, location_id: GODOWN, qty: '4.000', deleted_at: '2026-11-15T11:00:00Z' }),
        ],
      },
      'c3',
    );
    expect(
      stockFor(db, [PAD])
        .get(PAD)!
        .map((s) => s.qty),
    ).toEqual([5000, 0]);
  });

  it('shows nothing before the locations have come', () => {
    db = wrapOo1(new sqlite3.oo1.DB(':memory:'));
    migrate(db);
    expect(stockFor(db, [PAD]).get(PAD)).toEqual([]);
  });
});

describe("this counter's own bills (owner answer 1)", () => {
  it('a sale still in the outbox comes off the Shop at once', () => {
    bill('S', { lines: [sold(PAD, 3000), sold(HOSE, 1500)] });
    expect(shop(PAD)).toBe(5000);
    expect(shop(HOSE)).toBe(3000);
    // The Godown isn't touched: a sale leaves the Shop.
    expect(stockFor(db, [PAD]).get(PAD)![1]!.qty).toBe(4000);
  });

  it('a sale accepted after the last complete pull started still comes off; one accepted before is in the balance', () => {
    bill('S', { lines: [sold(PAD, 1000)] }, '2026-11-15T10:05:00.000Z');
    bill('S', { lines: [sold(PAD, 2000)] }, '2026-11-15T09:55:00.000Z');
    expect(shop(PAD)).toBe(7000);
  });

  it('a voided sale gives its stock back, whether or not the server has the sale yet', () => {
    const unsent = bill('S', { lines: [sold(PAD, 3000)] });
    bill('V', { saleId: unsent });
    expect(shop(PAD)).toBe(8000);
    // The balance has this sale already (8 is after it); its void hasn't reached the server.
    const synced = bill('S', { lines: [sold(HOSE, 1000)] }, '2026-11-15T09:30:00.000Z');
    bill('V', { saleId: synced });
    expect(shop(HOSE)).toBe(5500);
  });

  it('a resellable return adds to the Shop; a defective one goes to Damaged and is not shown', () => {
    bill('S', { lines: [back(PAD, 1000, 'resellable'), back(HOSE, 500, 'defective'), sold(HOSE, 1000)] });
    expect(shop(PAD)).toBe(9000);
    expect(shop(HOSE)).toBe(3500);
  });

  it('counts nothing twice once a later complete pull has the bill', () => {
    bill('S', { lines: [sold(PAD, 3000)] }, '2026-11-15T10:05:00.000Z');
    applyPull(
      db,
      { stock_balances: [row({ item_id: PAD, location_id: SHOP, qty: '5.000', row_version: '2' })] },
      'c2',
      true,
      '2026-11-15T10:10:00.000Z',
    );
    setSync(db, 'complete_pull_started_at', '2026-11-15T10:10:00.000Z');
    expect(shop(PAD)).toBe(5000);
  });
});

describe('speed (POS-02: the search stays within 100 ms)', () => {
  it('reads 50 results out of 20,000 items with balances in a few milliseconds', () => {
    const many = Array.from(
      { length: 20_000 },
      (_, i) => `019a0000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    applyPull(
      db,
      {
        stock_balances: many.flatMap((itemId, i) => [
          row({ item_id: itemId, location_id: SHOP, qty: `${i % 9}.000` }),
          row({ item_id: itemId, location_id: GODOWN, qty: `${i % 5}.000` }),
        ]),
      },
      'big',
    );
    for (let i = 0; i < 20; i++) bill('S', { lines: [sold(many[i * 7]!, 1000)] });
    const shown = many.slice(1000, 1050);
    const start = performance.now();
    const got = stockFor(db, shown);
    expect(performance.now() - start).toBeLessThan(20);
    expect(got.size).toBe(50);
    // Loading 40,000 balances into SQLite first takes longer than a test's 5 seconds under the full parallel run.
  }, 60_000);
});
