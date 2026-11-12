import { TenantSpec } from '@erp/contracts';
import { setupTenant, withTenant } from '@erp/db';
import { createTenant, createTestDatabase, seedCatalog, type TestDatabase } from '@erp/db/testing';
import { ROLE_TEMPLATES, type RoleTemplateKey } from '@erp/domain';
import { checkRebuild } from '@erp/posting';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import { buildApp } from './app';
import { hashPassword } from './auth/password';

// Back-office accounting (W1-19 plan; ACC-04, ACC-05, ACC-06; owner answers 1–6; D-108), under RLS and permissions, in
// one shop's order: the accountant records a customer's bank receipt, expenses and transfers (with charges), writes and
// posts journal vouchers, reverses a mistake once, locks October, and is refused anything dated in it; the owner
// reopens it with a reason. Then the balances, the ledger, new accounts and categories, and the rebuild.

const SHOP = 'acc-shop';
const OTHER = 'acc-other';
const HOST = 'app.example.test';
const ORIGIN = `https://${HOST}`;
const PASSWORD = 'correct horse battery';

let db: TestDatabase;
let pool: pg.Pool;
let tenant: string;
let items: Record<string, string>;
let customer: string;
let supplier: string;
const bank: Record<string, string> = {};
const category: Record<string, string> = {};
const account: Record<string, string> = {};
const loc: Record<string, string> = {};
const cookies: Record<string, string> = {};
// 11:00 in Karachi on Sunday 8 November 2026.
const app = () => buildApp({ pool, now: () => new Date('2026-11-08T06:00:00.000Z') });

async function addUser(username: string, template: RoleTemplateKey, tenantId = tenant) {
  const hash = await hashPassword(PASSWORD);
  await withTenant(pool, { tenantId }, async (_db, c) => {
    const role = await c.query<{ id: string }>(
      `INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, NULL, $3, $4)
       RETURNING id`,
      [tenantId, `${username} role`, ROLE_TEMPLATES[template].permissions, ROLE_TEMPLATES[template].limits],
    );
    const user = await c.query<{ id: string }>(
      `INSERT INTO erp.users (tenant_id, username, full_name, password_hash) VALUES ($1, $2, initcap($2), $3)
       RETURNING id`,
      [tenantId, username, hash],
    );
    await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
      tenantId,
      user.rows[0]!.id,
      role.rows[0]!.id,
    ]);
  });
}

const send = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  who: string,
  payload?: unknown,
) =>
  app().inject({
    method,
    url,
    headers: { origin: ORIGIN, host: HOST },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    cookies: { erp_session: cookies[who]! },
  });

async function login(username: string, shop = SHOP) {
  const res = await app().inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin: ORIGIN, host: HOST },
    payload: { tenantCode: shop, username, password: PASSWORD },
  });
  const c = res.cookies.find((x) => x.name === 'erp_session')?.value;
  if (!c) throw new Error(`login failed for ${username}: ${res.body}`);
  cookies[username] = c;
}

const sql = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
  withTenant(pool, { tenantId: tenant }, async (_db, c) => (await c.query<T>(text, params)).rows);

/** Debits − credits on an account, by code. */
async function balance(code: string): Promise<number> {
  const rows = await sql<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
     JOIN erp.accounts a ON a.id = l.account_id WHERE a.code = $1`,
    [code],
  );
  return Number(rows[0]!.b);
}

async function owed(partyId: string, role: 'customer' | 'supplier'): Promise<number> {
  const rows = await sql<{ b: string }>(
    'SELECT balance::text AS b FROM erp.party_balances WHERE party_id = $1 AND role = $2',
    [partyId, role],
  );
  return Number(rows[0]?.b ?? 0);
}

/** The posted journal of a document: account code, debit, credit, party. */
async function journal(type: string, id: string) {
  return sql<{ code: string; debit: string; credit: string; party_id: string | null }>(
    `SELECT a.code, l.debit::text AS debit, l.credit::text AS credit, l.party_id FROM erp.postings x
     JOIN erp.journal_entries e ON e.posting_seq = x.seq JOIN erp.journal_lines l ON l.entry_id = e.id
     JOIN erp.accounts a ON a.id = l.account_id WHERE x.source_type = $1 AND x.source_id = $2 ORDER BY l.line_no`,
    [type, id],
  );
}

const receipt = (over: Record<string, unknown> = {}) => ({
  customerId: customer,
  bankAccountId: bank['hbl'],
  amount: 2500000,
  receivedOn: '2026-11-08',
  reference: 'HBL 4471',
  note: null,
  ...over,
});

beforeAll(async () => {
  db = await createTestDatabase();
  pool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  ({ tenantId: tenant } = await setupTenant(db.ownerUrl, TenantSpec.parse({ ...deluxSpec, code: SHOP }), {
    ownerPasswordHash: 'x',
    mustChangePassword: false,
  }));
  const other = await createTenant(db.ownerUrl, 'Other Shop', OTHER);
  items = await withTenant(pool, { tenantId: tenant }, async (_db, c) =>
    seedCatalog(c, tenant, [
      { code: 'ABEA001', name: 'ADJUSTER BEARING SALOON', category: 'ABEA', prices: { RETAIL: 600000 } },
    ]),
  );
  for (const r of await sql<{ id: string; code: string }>('SELECT id, code FROM erp.bank_accounts'))
    bank[r.code] = r.id;
  for (const r of await sql<{ id: string; code: string }>('SELECT id, code FROM erp.expense_categories'))
    category[r.code] = r.id;
  for (const r of await sql<{ id: string; code: string }>('SELECT id, code FROM erp.accounts'))
    account[r.code] = r.id;
  for (const r of await sql<{ id: string; code: string }>('SELECT id, code FROM erp.locations'))
    loc[r.code] = r.id;
  await withTenant(pool, { tenantId: tenant }, async (_db, c) => {
    const tier = (await c.query<{ id: string }>("SELECT id FROM erp.price_tiers WHERE code = 'RETAIL'"))
      .rows[0]!.id;
    customer = (
      await c.query<{ id: string }>(
        "INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, 'KHAN', 'Khan Motors') RETURNING id",
        [tenant],
      )
    ).rows[0]!.id;
    await c.query(
      'INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, offline_daily_cap) VALUES ($1, $2, $3, 0)',
      [tenant, customer, tier],
    );
    supplier = (
      await c.query<{ id: string }>(
        "INSERT INTO erp.parties (tenant_id, code, name) VALUES ($1, 'NAVEED', 'Naveed Glass') RETURNING id",
        [tenant],
      )
    ).rows[0]!.id;
    await c.query('INSERT INTO erp.supplier_accounts (tenant_id, party_id) VALUES ($1, $2)', [
      tenant,
      supplier,
    ]);
  });
  await addUser('owner', 'owner');
  await addUser('alia', 'accountant');
  await addUser('maria', 'manager');
  await addUser('cash', 'cashier');
  await addUser('otto', 'owner', other);
  for (const u of ['owner', 'alia', 'maria', 'cash']) await login(u);
  await login('otto', OTHER);
});

afterAll(async () => {
  await pool.end();
  await db.drop();
});

describe('back-office accounting', () => {
  let receiptId: string;
  let expenseId: string;

  it('the accountant records a Rs 25,000 bank receipt: HBL up, the customer owes less, CR000001', async () => {
    const made = await send('POST', '/api/accounting/receipts', 'alia', receipt());
    expect(made.statusCode, made.body).toBe(201);
    const body = made.json<{ id: string; number: string }>();
    expect(body.number).toBe('CR000001');
    receiptId = body.id;
    expect(await journal('customer_receipt', receiptId)).toEqual([
      { code: '1160', debit: '2500000', credit: '0', party_id: null },
      { code: '1200', debit: '0', credit: '2500000', party_id: customer },
    ]);
    expect(await owed(customer, 'customer')).toBe(-2500000);
  });

  it('the same receipt again is a possible duplicate until confirmed', async () => {
    const again = await send('POST', '/api/accounting/receipts', 'alia', receipt());
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'possible_duplicate' });
    const confirmed = await send(
      'POST',
      '/api/accounting/receipts',
      'alia',
      receipt({ allowDuplicate: true }),
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(confirmed.json<{ number: string }>().number).toBe('CR000002');
  });

  it('a receipt dated tomorrow, or for a supplier, is refused', async () => {
    const tomorrow = await send(
      'POST',
      '/api/accounting/receipts',
      'alia',
      receipt({ receivedOn: '2026-11-09' }),
    );
    expect(tomorrow.statusCode).toBe(400);
    expect(tomorrow.json()).toMatchObject({ error: 'invalid', problems: ['date_in_future'] });
    const notCustomer = await send(
      'POST',
      '/api/accounting/receipts',
      'alia',
      receipt({ customerId: supplier }),
    );
    expect(notCustomer.statusCode).toBe(400);
  });

  it('expenses from Soneri and from the safe', async () => {
    const fromBank = await send('POST', '/api/accounting/expenses', 'alia', {
      categoryId: category['UTILITIES'],
      paidFrom: bank['soneri'],
      amount: 1850000,
      paidOn: '2026-11-08',
      reference: 'K-Electric',
      note: null,
    });
    expect(fromBank.statusCode, fromBank.body).toBe(201);
    expenseId = fromBank.json<{ id: string }>().id;
    expect(await journal('expense', expenseId)).toEqual([
      { code: '6210', debit: '1850000', credit: '0', party_id: null },
      { code: '1150', debit: '0', credit: '1850000', party_id: null },
    ]);
    const fromSafe = await send('POST', '/api/accounting/expenses', 'alia', {
      categoryId: category['GENERAL'],
      paidFrom: 'safe',
      amount: 45000,
      paidOn: '2026-11-08',
      reference: null,
      note: 'Tea',
    });
    expect(fromSafe.statusCode, fromSafe.body).toBe(201);
    expect(fromSafe.json<{ number: string }>().number).toBe('EX000002');
    expect(await balance('1130')).toBe(-45000);
  });

  it('card settlement into HBL with Rs 250 charges', async () => {
    const made = await send('POST', '/api/accounting/transfers', 'alia', {
      from: bank['card'],
      to: bank['hbl'],
      amount: 1000000,
      charges: 25000,
      chargesCategoryId: category['GENERAL'],
      movedOn: '2026-11-08',
      reference: null,
      note: null,
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(await journal('fund_transfer', made.json<{ id: string }>().id)).toEqual([
      { code: '1160', debit: '975000', credit: '0', party_id: null },
      { code: '6310', debit: '25000', credit: '0', party_id: null },
      { code: '1180', debit: '0', credit: '1000000', party_id: null },
    ]);
    const same = await send('POST', '/api/accounting/transfers', 'alia', {
      from: 'safe',
      to: 'safe',
      amount: 100,
      movedOn: '2026-11-08',
      reference: null,
      note: null,
    });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ problems: ['same_account'] });
  });

  it('an empty voucher draft is refused: nothing typed on any line (owner review of W1-19)', async () => {
    const blank = { accountId: null, partyId: null, debit: 0, credit: 0, memo: null };
    const res = await send('POST', '/api/accounting/vouchers', 'alia', {
      date: '2026-11-08',
      narration: '',
      lines: [blank, blank],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'empty_draft' });
  });

  it('a journal voucher: a draft, refused while unbalanced, then posted as JV000001 with the supplier entry', async () => {
    const draft = await send('POST', '/api/accounting/vouchers', 'alia', {
      date: '2026-11-08',
      narration: 'Opening difference with Naveed',
      lines: [
        { accountId: account['3300'], partyId: null, debit: 70000, credit: 0, memo: null },
        { accountId: account['2100'], partyId: supplier, debit: 0, credit: 60000, memo: null },
      ],
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json<{ id: string }>().id;
    const view = (await send('GET', `/api/accounting/vouchers/${id}`, 'alia')).json<{
      rowVersion: string;
      check: { problems: { problem: string }[] };
    }>();
    expect(view.check.problems).toEqual([{ problem: 'unbalanced', row: null }]);
    const refused = await send('POST', `/api/accounting/vouchers/${id}/post`, 'alia', {
      rowVersion: view.rowVersion,
    });
    expect(refused.statusCode).toBe(400);
    const saved = await send('PUT', `/api/accounting/vouchers/${id}`, 'alia', {
      rowVersion: view.rowVersion,
      date: '2026-11-08',
      narration: 'Opening difference with Naveed',
      lines: [
        { accountId: account['3300'], partyId: null, debit: 70000, credit: 0, memo: null },
        { accountId: account['2100'], partyId: supplier, debit: 0, credit: 70000, memo: 'Bill 118' },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = saved.json<{ rowVersion: string; check: { problems: unknown[] } }>();
    expect(after.check.problems).toEqual([]);
    const stale = await send('POST', `/api/accounting/vouchers/${id}/post`, 'alia', {
      rowVersion: view.rowVersion,
    });
    expect(stale.statusCode).toBe(409);
    const posted = await send('POST', `/api/accounting/vouchers/${id}/post`, 'alia', {
      rowVersion: after.rowVersion,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    expect(posted.json<{ number: string }>().number).toBe('JV000001');
    expect(await owed(supplier, 'supplier')).toBe(70000);
    const edit = await send('PUT', `/api/accounting/vouchers/${id}`, 'alia', {
      rowVersion: after.rowVersion,
      date: '2026-11-08',
      narration: 'x',
      lines: [],
    });
    expect(edit.statusCode).toBe(409);
    // The database refuses the change too (rule 3).
    await expect(
      sql('UPDATE erp.journal_vouchers SET narration = $2 WHERE id = $1', [id, 'x']),
    ).rejects.toThrow(/posted/);
  });

  it('a voucher can never touch Inventory, the drawer or cash in transit', async () => {
    const draft = await send('POST', '/api/accounting/vouchers', 'alia', {
      date: '2026-11-08',
      narration: 'Stock by voucher',
      lines: [
        { accountId: account['1300'], partyId: null, debit: 100, credit: 0, memo: null },
        { accountId: account['3300'], partyId: null, debit: 0, credit: 100, memo: null },
      ],
    });
    const id = draft.json<{ id: string }>().id;
    const v = (await send('GET', `/api/accounting/vouchers/${id}`, 'alia')).json<{ rowVersion: string }>();
    const refused = await send('POST', `/api/accounting/vouchers/${id}/post`, 'alia', {
      rowVersion: v.rowVersion,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ problems: [{ problem: 'account_kept', row: 0 }] });
    const gone = await send('DELETE', `/api/accounting/vouchers/${id}?rowVersion=${v.rowVersion}`, 'alia');
    expect(gone.statusCode).toBe(200);
  });

  it('an expense reversed once: Soneri back, the reversal itself not reversible, the date not before the original', async () => {
    const early = await send('POST', '/api/accounting/reverse', 'alia', {
      type: 'expense',
      id: expenseId,
      date: '2026-11-07',
    });
    expect(early.statusCode).toBe(400);
    expect(early.json()).toMatchObject({ problems: ['before_original'] });
    const made = await send('POST', '/api/accounting/reverse', 'alia', {
      type: 'expense',
      id: expenseId,
      date: '2026-11-08',
    });
    expect(made.statusCode, made.body).toBe(201);
    const rev = made.json<{ id: string; number: string }>();
    expect(rev.number).toBe('JV000002');
    expect(await balance('1150')).toBe(0);
    expect(await balance('6210')).toBe(0);
    const twice = await send('POST', '/api/accounting/reverse', 'alia', {
      type: 'expense',
      id: expenseId,
      date: '2026-11-08',
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ error: 'already_reversed' });
    const ofReversal = await send('POST', '/api/accounting/reverse', 'alia', {
      type: 'journal_voucher',
      id: rev.id,
      date: '2026-11-08',
    });
    expect(ofReversal.statusCode).toBe(409);
    const view = (await send('GET', `/api/accounting/documents/expense/${expenseId}`, 'alia')).json<{
      reversedBy: { number: string } | null;
      canReverse: boolean;
    }>();
    expect(view.reversedBy?.number).toBe('JV000002');
    expect(view.canReverse).toBe(false);
  });

  it('a reversed receipt: the customer owes it again', async () => {
    const before = await owed(customer, 'customer');
    const made = await send('POST', '/api/accounting/reverse', 'alia', {
      type: 'customer_receipt',
      id: receiptId,
      date: '2026-11-08',
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(await owed(customer, 'customer')).toBe(before + 2500000);
  });

  it('the money list holds every kind, drafts first', async () => {
    const list = (await send('GET', '/api/accounting/documents', 'alia')).json<
      { type: string; number: string | null }[]
    >();
    expect(new Set(list.map((d) => d.type))).toEqual(
      new Set(['customer_receipt', 'expense', 'fund_transfer', 'journal_voucher']),
    );
    const receipts = (await send('GET', '/api/accounting/documents?type=customer_receipt', 'alia')).json<
      { number: string }[]
    >();
    expect(receipts.map((r) => r.number).sort()).toEqual(['CR000001', 'CR000002']);
  });

  it('who may do what (owner answer 1): no accounting for the manager or a cashier', async () => {
    expect((await send('POST', '/api/accounting/receipts', 'maria', receipt())).statusCode).toBe(403);
    expect((await send('GET', '/api/accounting/lookups', 'cash')).statusCode).toBe(403);
    const lookups = (await send('GET', '/api/accounting/lookups', 'alia')).json<{
      can: Record<string, boolean>;
    }>();
    expect(lookups.can).toMatchObject({ journal: true, close: true, reopen: false, chart: true });
  });

  it('October locked by the accountant; anything dated in it refused, a later date still posts', async () => {
    const checklist = await send('GET', '/api/accounting/periods/checklist?to=2026-10-31', 'alia');
    expect(checklist.statusCode).toBe(200);
    const locked = await send('POST', '/api/accounting/lock', 'alia', {
      lockDate: '2026-10-31',
      reason: null,
    });
    expect(locked.statusCode, locked.body).toBe(200);
    const inOctober = await send(
      'POST',
      '/api/accounting/receipts',
      'alia',
      receipt({ receivedOn: '2026-10-31' }),
    );
    expect(inOctober.statusCode).toBe(400);
    expect(inOctober.json()).toMatchObject({ problems: ['date_locked'] });
    // A stock adjustment and a supplier payment dated in October are refused too (D-108).
    const adj = await send('POST', '/api/inventory/adjustments', 'owner', {
      locationId: loc['SHOP'],
      adjustedOn: '2026-10-31',
      reason: 'found',
      note: null,
      lines: [{ itemId: items['ABEA001'], qty: 1000 }],
    });
    expect(adj.statusCode, adj.body).toBe(201);
    const a = adj.json<{ id: string; rowVersion: string }>();
    const posted = await send('POST', `/api/inventory/adjustments/${a.id}/post`, 'owner', {
      rowVersion: a.rowVersion,
    });
    expect(posted.statusCode).toBe(409);
    expect(posted.json()).toMatchObject({ error: 'date_locked', lockDate: '2026-10-31' });
    const payment = await send('POST', '/api/purchasing/payments', 'owner', {
      supplierId: supplier,
      bankAccountId: bank['hbl'],
      amount: 1000,
      paidOn: '2026-10-30',
      reference: null,
    });
    expect(payment.statusCode).toBe(409);
    const later = await send(
      'POST',
      '/api/accounting/receipts',
      'alia',
      receipt({ receivedOn: '2026-11-01', amount: 100 }),
    );
    expect(later.statusCode, later.body).toBe(201);
    const fixed = await sql<{ fiscal_year_locked: boolean }>('SELECT fiscal_year_locked FROM erp.tenants');
    expect(fixed[0]!.fiscal_year_locked).toBe(true);
  });

  it('only the owner reopens, with a reason, and it is audited (owner answer 5)', async () => {
    const accountant = await send('POST', '/api/accounting/lock', 'alia', {
      lockDate: '2026-09-30',
      reason: 'x',
    });
    expect(accountant.statusCode).toBe(400);
    expect(accountant.json()).toMatchObject({ problems: ['reopen_not_allowed'] });
    const noReason = await send('POST', '/api/accounting/lock', 'owner', {
      lockDate: '2026-09-30',
      reason: null,
    });
    expect(noReason.json()).toMatchObject({ problems: ['reason_required'] });
    const notOver = await send('POST', '/api/accounting/lock', 'owner', {
      lockDate: '2026-11-30',
      reason: null,
    });
    expect(notOver.json()).toMatchObject({ problems: ['month_not_over'] });
    const reopened = await send('POST', '/api/accounting/lock', 'owner', {
      lockDate: '2026-09-30',
      reason: 'A missed bank receipt',
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    const periods = (await send('GET', '/api/accounting/periods', 'alia')).json<{
      lockDate: string;
      next: string | null;
      history: { from: string | null; to: string; reason: string | null }[];
      years: { label: string; months: { end: string; locked: boolean }[] }[];
    }>();
    expect(periods.lockDate).toBe('2026-09-30');
    expect(periods.next).toBe('2026-10-31');
    expect(periods.history[0]).toMatchObject({
      from: '2026-10-31',
      to: '2026-09-30',
      reason: 'A missed bank receipt',
    });
    expect(periods.history[1]).toMatchObject({ from: null, to: '2026-10-31' });
    expect(periods.years.map((y) => y.label)).toEqual(['2026']);
    expect(periods.years[0]!.months.filter((m) => m.locked)).toHaveLength(9);
  });

  it('balances at a date and an account ledger with its running balance', async () => {
    const rows = (await send('GET', '/api/accounting/accounts', 'alia')).json<
      { code: string; balance: number; postable: boolean }[]
    >();
    const hbl = rows.find((r) => r.code === '1160')!;
    expect(hbl.balance).toBe(2500000 + 2500000 + 975000 - 2500000 + 100);
    // A heading sums its children: Assets equal minus everything else, since the books balance.
    const total = rows.filter((r) => r.postable).reduce((s, r) => s + r.balance, 0);
    expect(total).toBe(0);
    const ledger = (
      await send(
        'GET',
        `/api/accounting/accounts/${account['1160']}/ledger?from=2026-11-01&to=2026-11-30`,
        'alia',
      )
    ).json<{
      opening: number;
      closing: number;
      lines: { debit: number; credit: number; balance: number }[];
    }>();
    expect(ledger.opening).toBe(0);
    expect(ledger.closing).toBe(hbl.balance);
    let running = 0;
    for (const l of ledger.lines) {
      running += l.debit - l.credit;
      expect(l.balance).toBe(running);
    }
    expect((await send('GET', '/api/accounting/accounts', 'maria')).statusCode).toBe(403);
  });

  it('a new expense account and category (owner answer 4); a taken code, a postable parent refused', async () => {
    const made = await send('POST', '/api/accounting/accounts', 'alia', {
      parentId: account['6000'],
      code: '6250',
      name: 'Internet',
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ id: string }>().id;
    expect(
      (
        await send('POST', '/api/accounting/accounts', 'alia', {
          parentId: account['6000'],
          code: '6250',
          name: 'x',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await send('POST', '/api/accounting/accounts', 'alia', {
          parentId: account['1160'],
          code: '1161',
          name: 'x',
        })
      ).statusCode,
    ).toBe(400);
    const cat = await send('POST', '/api/accounting/categories', 'alia', {
      code: 'INTERNET',
      name: 'Internet',
      accountId: id,
    });
    expect(cat.statusCode, cat.body).toBe(201);
    const onBank = await send('POST', '/api/accounting/categories', 'alia', {
      code: 'BAD',
      name: 'Bad',
      accountId: account['1160'],
    });
    expect(onBank.statusCode).toBe(400);
    // A category in use keeps its account active; one with a balance can't be closed either.
    expect(
      (await send('PATCH', `/api/accounting/accounts/${id}`, 'alia', { active: false })).statusCode,
    ).toBe(409);
    expect(
      (await send('PATCH', `/api/accounting/accounts/${account['1160']}`, 'alia', { active: false }))
        .statusCode,
    ).toBe(409);
    expect(
      (await send('POST', '/api/accounting/categories', 'maria', { code: 'X', name: 'X', accountId: id }))
        .statusCode,
    ).toBe(403);
  });

  it('another shop sees none of it (RLS)', async () => {
    expect((await send('GET', `/api/accounting/documents/expense/${expenseId}`, 'otto')).statusCode).toBe(
      404,
    );
    expect((await send('GET', '/api/accounting/documents', 'otto')).json()).toEqual([]);
  });

  it('the rebuild arrives at the same ledgers, reversals included', async () => {
    expect((await checkRebuild(pool, tenant)).differences).toEqual([]);
  });
});
