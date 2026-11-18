import {
  CreateAccountRequest,
  CreateExpenseCategoryRequest,
  CustomerReceiptRequest,
  ExpenseRequest,
  FundTransferRequest,
  LockRequest,
  PostVoucherRequest,
  REVERSIBLE_TYPES,
  ReverseRequest,
  SaveVoucherRequest,
  UpdateAccountRequest,
  UpdateExpenseCategoryRequest,
  VoucherDraft,
  type AccountBalanceRow,
  type AccountingDocumentRow,
  type AccountingDocumentType,
  type AccountingDocumentView,
  type AccountingLookups,
  type AccountRow,
  type LedgerView,
  type LockChecklist,
  type PartyHit,
  type PeriodsView,
  type VoucherView,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import {
  can,
  checkDocumentDate,
  checkJournalVoucher,
  checkLockMove,
  checkMoneyDocument,
  fiscalYearOf,
  monthEnd,
  validateChartOfAccounts,
  type MoneyDocumentInput,
  type Permission,
  type SystemRole,
  type VoucherAccount,
  isEmptyDraft,
} from '@erp/domain';
import { postDocument } from '@erp/posting';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requireAnyPermission, requirePermission } from '../auth/routes';
import { lockedOn, shopDay } from '../lock';
import { csv, moneyOf, sendCsv, type Cell } from '../reports/routes';

// Back-office accounting (W1-19 plan; ACC-04, ACC-05, ACC-06, part of ACC-07; owner answers 1–6; D-108).
// - Customer receipts by bank (acc.receipt.create), expenses (acc.expense.create) and transfers between banks, wallets,
//   card settlement and the safe (acc.payment.create) are checked, numbered and posted in one transaction.
// - Journal vouchers (acc.journal.post) are drafts until posted; Reverse writes a posted voucher that swaps a posted
//   document's journal (rule 3), once.
// - The lock date moves forward by acc.period.close and back only by acc.period.reopen (the owner) with a reason.
// - Account balances and ledgers need reports.financial; new accounts and categories acc.chart.edit.
// Nothing back-office posts on or before the lock date (D-108).

interface Deps {
  pool: pg.Pool;
  now: () => Date;
  requireAuth: preHandlerAsyncHookHandler;
}

class Created {
  constructor(readonly body: unknown) {}
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body['error']));
  }
}

type Client = pg.PoolClient;
/** A receipt, expense or transfer as typed, before the shop's day and the same-day documents are added. */
type MoneyDraft = MoneyDocumentInput extends infer T
  ? T extends unknown
    ? Omit<T, 'today' | 'lockDate' | 'sameDay'>
    : never
  : never;
type Row = Record<string, unknown>;

const TABLES: Record<AccountingDocumentType, string> = {
  customer_receipt: 'customer_receipts',
  expense: 'expenses',
  fund_transfer: 'fund_transfers',
  supplier_payment: 'supplier_payments',
  journal_voucher: 'journal_vouchers',
};

type Posted = 'customer_receipt' | 'expense' | 'fund_transfer' | 'journal_voucher';

/** The next number of a family, in the transaction that posts the document. */
async function nextNumber(c: Client, tenantId: string, family: 'CR' | 'EX' | 'FT' | 'JV'): Promise<string> {
  const { rows } = await c.query<{ last_no: string }>(
    `INSERT INTO erp.document_counters (tenant_id, family, last_no) VALUES ($1, $2, 1)
     ON CONFLICT (tenant_id, family) DO UPDATE SET last_no = erp.document_counters.last_no + 1
     RETURNING last_no::text`,
    [tenantId, family],
  );
  return `${family}${rows[0]!.last_no.padStart(6, '0')}`;
}

/** The shop's branch: back-office money belongs to the branch of its Shop (one branch in the MVP). */
async function shopBranch(c: Client): Promise<string> {
  const r = await c.query<{ id: string }>(
    "SELECT branch_id AS id FROM erp.locations WHERE code = 'SHOP' AND deleted_at IS NULL ORDER BY code LIMIT 1",
  );
  if (!r.rows[0]) throw new Refusal(400, { error: 'invalid_request' });
  return r.rows[0].id;
}

/** A query-string value as text ('' when absent or repeated). */
const param = (req: FastifyRequest, key: string) => {
  const v = (req.query as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
};

const safeOf = (end: string) => (end === 'safe' ? null : end);

/**
 * Every back-office money document as one list (the money screen): receipts, expenses, transfers, supplier payments
 * and vouchers, each with what reversed it or what it reverses. The safe's name is its account's.
 */
const DOCUMENTS = `
  WITH safe AS (SELECT name FROM erp.accounts WHERE system_role = 'CASH_SAFE'),
  docs AS (
    SELECT 'customer_receipt' AS type, r.id, r.number, r.business_date, 'posted' AS status, r.amount,
      p.name AS description, r.reference, r.note, r.created_by_user_id, r.created_at, NULL::text AS rtype,
      NULL::uuid AS rid
    FROM erp.customer_receipts r JOIN erp.parties p ON p.id = r.customer_party_id
    UNION ALL
    SELECT 'expense', e.id, e.number, e.business_date, 'posted', e.amount,
      k.name || ' · ' || coalesce(b.name, (SELECT name FROM safe)), e.reference, e.note, e.created_by_user_id,
      e.created_at, NULL, NULL
    FROM erp.expenses e JOIN erp.expense_categories k ON k.id = e.expense_category_id
    LEFT JOIN erp.bank_accounts b ON b.id = e.paid_from_bank_account_id
    UNION ALL
    SELECT 'fund_transfer', f.id, f.number, f.business_date, 'posted', f.amount,
      coalesce(fb.name, (SELECT name FROM safe)) || ' → ' || coalesce(tb.name, (SELECT name FROM safe)), f.reference,
      f.note, f.created_by_user_id, f.created_at, NULL, NULL
    FROM erp.fund_transfers f LEFT JOIN erp.bank_accounts fb ON fb.id = f.from_bank_account_id
    LEFT JOIN erp.bank_accounts tb ON tb.id = f.to_bank_account_id
    UNION ALL
    SELECT 'supplier_payment', s.id, s.number, s.business_date, 'posted', s.amount, p.name, s.reference, NULL,
      s.created_by_user_id, s.created_at, NULL, NULL
    FROM erp.supplier_payments s JOIN erp.parties p ON p.id = s.supplier_party_id
    UNION ALL
    SELECT 'journal_voucher', v.id, v.number, v.business_date, v.status,
      CASE WHEN v.status = 'posted' THEN coalesce((
        SELECT sum(l.debit) FROM erp.postings x JOIN erp.journal_entries j ON j.posting_seq = x.seq
        JOIN erp.journal_lines l ON l.entry_id = j.id
        WHERE x.source_type = 'journal_voucher' AND x.source_id = v.id), 0)
      ELSE coalesce((SELECT sum(l.debit) FROM erp.journal_voucher_lines l WHERE l.voucher_id = v.id), 0) END,
      coalesce(v.narration, ''), NULL, NULL, v.created_by_user_id, v.created_at, v.reverses_type, v.reverses_id
    FROM erp.journal_vouchers v
  )
  SELECT d.type, d.id, d.number, d.business_date::text AS date, d.status, d.amount::text AS amount, d.description,
    d.reference, d.note, u.full_name AS created_by, d.created_at, rv.id AS reversed_by_id,
    rv.number AS reversed_by_number, d.rtype, d.rid,
    (SELECT number FROM erp.customer_receipts WHERE id = d.rid UNION ALL SELECT number FROM erp.expenses WHERE id = d.rid
     UNION ALL SELECT number FROM erp.fund_transfers WHERE id = d.rid
     UNION ALL SELECT number FROM erp.supplier_payments WHERE id = d.rid
     UNION ALL SELECT number FROM erp.journal_vouchers WHERE id = d.rid LIMIT 1) AS rnumber
  FROM docs d
  LEFT JOIN erp.journal_vouchers rv ON rv.reverses_type = d.type AND rv.reverses_id = d.id
  LEFT JOIN erp.users u ON u.id = d.created_by_user_id`;

function documentRow(r: Row): AccountingDocumentRow {
  return {
    type: r['type'] as AccountingDocumentType,
    id: r['id'] as string,
    number: (r['number'] as string | null) ?? null,
    date: r['date'] as string,
    status: r['status'] as 'draft' | 'posted',
    amount: Number(r['amount']),
    description: (r['description'] as string | null) ?? '',
    reference: (r['reference'] as string | null) ?? null,
    reversedBy:
      r['reversed_by_id'] === null
        ? null
        : { id: r['reversed_by_id'] as string, number: r['reversed_by_number'] as string },
    reverses:
      r['rid'] === null
        ? null
        : {
            type: r['rtype'] as AccountingDocumentType,
            id: r['rid'] as string,
            number: r['rnumber'] as string,
          },
  };
}

/** A document's journal as it was posted, with account and party names. */
async function journalOf(c: Client, type: AccountingDocumentType, id: string) {
  const { rows } = await c.query<Row>(
    `SELECT j.number AS journal, x.entry_date::text AS entry_date, l.account_id, a.code, a.name, p.name AS party,
       l.debit::text AS debit, l.credit::text AS credit
     FROM erp.postings x JOIN erp.journal_entries j ON j.posting_seq = x.seq
     JOIN erp.journal_lines l ON l.entry_id = j.id JOIN erp.accounts a ON a.id = l.account_id
     LEFT JOIN erp.parties p ON p.id = l.party_id
     WHERE x.source_type = $1 AND x.source_id = $2 ORDER BY l.line_no`,
    [type, id],
  );
  return {
    number: (rows[0]?.['journal'] as string | undefined) ?? null,
    entryDate: (rows[0]?.['entry_date'] as string | undefined) ?? null,
    lines: rows.map((r) => ({
      accountId: r['account_id'] as string,
      accountCode: r['code'] as string,
      accountName: r['name'] as string,
      partyName: (r['party'] as string | null) ?? null,
      debit: Number(r['debit']),
      credit: Number(r['credit']),
    })),
  };
}

/** What a voucher's check needs to know about the accounts and parties its lines name. */
async function voucherFacts(c: Client, lines: { accountId: string | null; partyId: string | null }[]) {
  const accountIds = [...new Set(lines.map((l) => l.accountId).filter((v): v is string => v !== null))];
  const partyIds = [...new Set(lines.map((l) => l.partyId).filter((v): v is string => v !== null))];
  const accounts: Record<string, VoucherAccount> = {};
  for (const r of (
    await c.query<{ id: string; is_postable: boolean; active: boolean; system_role: SystemRole | null }>(
      `SELECT id, is_postable, is_active AND deleted_at IS NULL AS active, system_role FROM erp.accounts
       WHERE id = ANY($1::uuid[])`,
      [accountIds],
    )
  ).rows)
    accounts[r.id] = { postable: r.is_postable, active: r.active, role: r.system_role };
  const parties: Record<string, { customer: boolean; supplier: boolean }> = {};
  for (const r of (
    await c.query<{ id: string; customer: boolean; supplier: boolean }>(
      `SELECT p.id,
         EXISTS (SELECT 1 FROM erp.customer_accounts ca WHERE ca.party_id = p.id AND ca.deleted_at IS NULL) AS customer,
         EXISTS (SELECT 1 FROM erp.supplier_accounts sa WHERE sa.party_id = p.id AND sa.deleted_at IS NULL) AS supplier
       FROM erp.parties p WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL`,
      [partyIds],
    )
  ).rows)
    parties[r.id] = { customer: r.customer, supplier: r.supplier };
  return { accounts, parties };
}

async function voucherView(c: Client, id: string, now: Date): Promise<VoucherView | null> {
  const h = (
    await c.query<Row>(
      `SELECT v.*, v.business_date::text AS day, v.row_version::text AS rv, u.full_name AS by
       FROM erp.journal_vouchers v LEFT JOIN erp.users u ON u.id = v.updated_by_user_id
       WHERE v.id = $1 AND v.reverses_id IS NULL`,
      [id],
    )
  ).rows[0];
  if (!h) return null;
  const lines = (
    await c.query<Row>(
      `SELECT l.account_id, l.party_id, p.name AS party, l.debit::text AS debit, l.credit::text AS credit, l.memo
       FROM erp.journal_voucher_lines l LEFT JOIN erp.parties p ON p.id = l.party_id
       WHERE l.voucher_id = $1 ORDER BY l.line_no`,
      [id],
    )
  ).rows.map((r) => ({
    accountId: (r['account_id'] as string | null) ?? null,
    partyId: (r['party_id'] as string | null) ?? null,
    partyName: (r['party'] as string | null) ?? null,
    debit: Number(r['debit']),
    credit: Number(r['credit']),
    memo: (r['memo'] as string | null) ?? null,
  }));
  const { today, lockDate } = await shopDay(c, now);
  const facts = await voucherFacts(c, lines);
  const posted = h['status'] === 'posted';
  const check = checkJournalVoucher({
    date: h['day'] as string,
    today,
    // A posted voucher was checked when it posted; only its totals matter now.
    lockDate: posted ? null : lockDate,
    narration: (h['narration'] as string | null) ?? null,
    lines,
    ...facts,
  });
  return {
    id,
    number: (h['number'] as string | null) ?? null,
    status: h['status'] as 'draft' | 'posted',
    date: h['day'] as string,
    narration: (h['narration'] as string | null) ?? null,
    rowVersion: h['rv'] as string,
    lines,
    check: posted ? { problems: [], debit: check.debit, credit: check.credit } : check,
    updatedBy: (h['by'] as string | null) ?? null,
    updatedAt: (h['updated_at'] as Date).toISOString(),
  };
}

/** Debits − credits per account up to a date (null = everything). */
async function balances(c: Client, at: string | null): Promise<Map<string, number>> {
  const { rows } = await c.query<{ account_id: string; balance: string }>(
    `SELECT l.account_id, sum(l.debit - l.credit)::text AS balance FROM erp.journal_lines l
     JOIN erp.journal_entries e ON e.id = l.entry_id
     WHERE $1::date IS NULL OR e.entry_date <= $1 GROUP BY l.account_id`,
    [at],
  );
  return new Map(rows.map((r) => [r.account_id, Number(r.balance)]));
}

async function accountRows(c: Client): Promise<(AccountRow & { inUse: boolean })[]> {
  const { rows } = await c.query<Row>(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, a.is_postable, a.is_active, a.system_role,
       (a.system_role IS NOT NULL
        OR EXISTS (SELECT 1 FROM erp.bank_accounts b WHERE b.gl_account_id = a.id AND b.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM erp.expense_categories k WHERE k.gl_account_id = a.id AND k.deleted_at IS NULL
                   AND k.is_active)
        OR EXISTS (SELECT 1 FROM erp.accounts ch WHERE ch.parent_id = a.id AND ch.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM erp.journal_lines l WHERE l.account_id = a.id)) AS in_use
     FROM erp.accounts a WHERE a.deleted_at IS NULL ORDER BY a.code`,
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    code: r['code'] as string,
    name: r['name'] as string,
    type: r['type'] as AccountRow['type'],
    parentId: (r['parent_id'] as string | null) ?? null,
    postable: r['is_postable'] as boolean,
    active: r['is_active'] as boolean,
    role: (r['system_role'] as string | null) ?? null,
    inUse: r['in_use'] as boolean,
  }));
}

/** An account row without its in-use flag. */
function plainAccount(a: AccountRow & { inUse: boolean }): AccountRow {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    parentId: a.parentId,
    postable: a.postable,
    active: a.active,
    role: a.role,
  };
}

export function registerAccounting(scope: FastifyInstance, { pool, now, requireAuth }: Deps) {
  const read = requireAnyPermission(requireAuth, [
    'acc.receipt.create',
    'acc.payment.create',
    'acc.expense.create',
    'acc.journal.post',
    'acc.period.close',
    'reports.financial',
  ]);
  const receipt = requirePermission(requireAuth, 'acc.receipt.create');
  const expense = requirePermission(requireAuth, 'acc.expense.create');
  const transfer = requirePermission(requireAuth, 'acc.payment.create');
  const journal = requirePermission(requireAuth, 'acc.journal.post');
  const lock = requireAnyPermission(requireAuth, ['acc.period.close', 'acc.period.reopen']);
  const financial = requirePermission(requireAuth, 'reports.financial');
  const chart = requirePermission(requireAuth, 'acc.chart.edit');
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);

  const run = async <T>(req: FastifyRequest, reply: FastifyReply, fn: (c: Client) => Promise<T>) => {
    try {
      const out = await withTenant(
        pool,
        { tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.id },
        (_db, c) => fn(c),
      );
      return out instanceof Created ? reply.code(201).send(out.body) : out;
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send(err.body);
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'journal_vouchers_reverses_uq')
        return reply.code(409).send({ error: 'already_reversed' });
      if (e.code === '23505' && e.constraint === 'accounts_tenant_id_code_key')
        return reply.code(409).send({ error: 'code_taken' });
      if (e.code === '23505' && e.constraint === 'expense_categories_tenant_id_code_key')
        return reply.code(409).send({ error: 'code_taken' });
      if (e.code === '23503' || e.code === '22P02' || e.code === '23514')
        return reply.code(400).send({ error: 'invalid_request' });
      throw err;
    }
  };

  /** Posts in this transaction; a document dated in a locked month, or a posting that fails, refuses it all. */
  const post = async (req: FastifyRequest, c: Client, type: Posted, id: string) => {
    const locked = await lockedOn(c, type, id);
    if (locked !== null) throw new Refusal(409, { error: 'date_locked', lockDate: locked });
    const outcome = await postDocument(c, { tenantId: req.auth!.tenantId, type, id, now: now() });
    if (outcome.status === 'failed') throw new Refusal(400, { error: 'posting_failed', code: outcome.code });
  };

  /** Checks a receipt, expense or transfer as the screen does; a duplicate needs `allowDuplicate`. */
  const checkMoney = async (c: Client, doc: MoneyDraft, allowDuplicate: boolean) => {
    const { today, lockDate } = await shopDay(c, now());
    const sameDaySql = {
      receipt:
        'SELECT customer_party_id::text AS key, amount FROM erp.customer_receipts WHERE business_date = $1',
      expense: 'SELECT expense_category_id::text AS key, amount FROM erp.expenses WHERE business_date = $1',
      transfer: `SELECT coalesce(from_bank_account_id::text, 'safe') || '>' || coalesce(to_bank_account_id::text, 'safe')
                   AS key, amount FROM erp.fund_transfers WHERE business_date = $1`,
    }[doc.kind];
    const sameDay = doc.date
      ? (await c.query<{ key: string; amount: string }>(sameDaySql, [doc.date])).rows.map((r) => ({
          key: r.key,
          amount: Number(r.amount),
        }))
      : [];
    const result = checkMoneyDocument({ ...doc, today, lockDate, sameDay });
    if (result.problems.length > 0) throw new Refusal(400, { error: 'invalid', problems: result.problems });
    if (result.warnings.length > 0 && !allowDuplicate)
      throw new Refusal(409, { error: 'possible_duplicate', warnings: result.warnings });
  };

  /** A bank account that is still in use, or 400. */
  const activeBank = async (c: Client, id: string | null) => {
    if (id === null) return;
    const r = await c.query(
      'SELECT 1 FROM erp.bank_accounts WHERE id = $1 AND is_active AND deleted_at IS NULL',
      [id],
    );
    if (!r.rowCount) throw new Refusal(400, { error: 'invalid_request' });
  };
  const activeCategory = async (c: Client, id: string | null) => {
    if (id === null) return;
    const r = await c.query(
      'SELECT 1 FROM erp.expense_categories WHERE id = $1 AND is_active AND deleted_at IS NULL',
      [id],
    );
    if (!r.rowCount) throw new Refusal(400, { error: 'invalid_request' });
  };

  scope.get('/accounting/lookups', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const t = (
        await c.query<{ live: boolean; start: number }>(
          'SELECT go_live_at IS NOT NULL AS live, fiscal_year_start_month AS start FROM erp.tenants',
        )
      ).rows[0]!;
      const { today, lockDate } = await shopDay(c, now());
      const out: AccountingLookups = {
        live: t.live,
        today,
        lockDate,
        fiscalYearStartMonth: t.start,
        money: await moneyOf(c),
        banks: (
          await c.query<AccountingLookups['banks'][number]>(
            `SELECT id, code, name, kind, gl_account_id AS "accountId" FROM erp.bank_accounts
             WHERE is_active AND deleted_at IS NULL ORDER BY name`,
          )
        ).rows,
        categories: (
          await c.query<AccountingLookups['categories'][number]>(
            `SELECT id, code, name, gl_account_id AS "accountId", is_active AS active FROM erp.expense_categories
             WHERE deleted_at IS NULL ORDER BY lower(name)`,
          )
        ).rows,
        accounts: (await accountRows(c)).map(plainAccount),
        can: {
          receipt: allowed(req, 'acc.receipt.create'),
          expense: allowed(req, 'acc.expense.create'),
          transfer: allowed(req, 'acc.payment.create'),
          journal: allowed(req, 'acc.journal.post'),
          close: allowed(req, 'acc.period.close'),
          reopen: allowed(req, 'acc.period.reopen'),
          chart: allowed(req, 'acc.chart.edit'),
          financial: allowed(req, 'reports.financial'),
        },
      };
      return out;
    }),
  );

  // Customers and suppliers for a receipt or a voucher line: code, name or phone.
  scope.get('/accounting/parties', { preHandler: read }, async (req, reply) => {
    const q = (param(req, 'q') || '').trim();
    const role = param(req, 'role') || 'any';
    if (q.length === 0) return [];
    return run(req, reply, async (c) => {
      const like = `%${q.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
      const { rows } = await c.query<Row>(
        `SELECT * FROM (
           SELECT p.id, p.code, p.name,
             EXISTS (SELECT 1 FROM erp.customer_accounts ca WHERE ca.party_id = p.id AND ca.deleted_at IS NULL) AS customer,
             EXISTS (SELECT 1 FROM erp.supplier_accounts sa WHERE sa.party_id = p.id AND sa.deleted_at IS NULL) AS supplier,
             coalesce((SELECT balance FROM erp.party_balances b WHERE b.party_id = p.id AND b.role = 'customer'), 0)::text AS cb,
             coalesce((SELECT balance FROM erp.party_balances b WHERE b.party_id = p.id AND b.role = 'supplier'), 0)::text AS sb
           FROM erp.parties p
           WHERE p.deleted_at IS NULL AND p.status = 'active'
             AND (p.code ILIKE $1 OR p.name ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(p.phones) ph WHERE ph LIKE $1))
         ) x
         WHERE ($2 = 'customer' AND customer) OR ($2 = 'supplier' AND supplier) OR ($2 = 'any' AND (customer OR supplier))
         ORDER BY lower(name) LIMIT 20`,
        [like, role],
      );
      return rows.map((r): PartyHit => ({
        id: r['id'] as string,
        code: r['code'] as string,
        name: r['name'] as string,
        customer: r['customer'] as boolean,
        supplier: r['supplier'] as boolean,
        customerBalance: Number(r['cb']),
        supplierBalance: Number(r['sb']),
      }));
    });
  });

  // ---- The money list and a document ----

  scope.get('/accounting/documents', { preHandler: read }, async (req, reply) => {
    const q = req.query as { type?: string; from?: string; to?: string };
    const type = q.type && (REVERSIBLE_TYPES as readonly string[]).includes(q.type) ? q.type : null;
    const day = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `${DOCUMENTS}
         WHERE ($1::text IS NULL OR d.type = $1) AND ($2::date IS NULL OR d.business_date >= $2)
           AND ($3::date IS NULL OR d.business_date <= $3)
         ORDER BY d.status = 'draft' DESC, d.business_date DESC, d.number DESC NULLS FIRST, d.created_at DESC
         LIMIT 300`,
        [type, day(q.from), day(q.to)],
      );
      return rows.map(documentRow);
    });
  });

  scope.get('/accounting/documents/:type/:id', { preHandler: read }, async (req, reply) => {
    const { type, id } = req.params as { type: string; id: string };
    if (!(REVERSIBLE_TYPES as readonly string[]).includes(type))
      return reply.code(404).send({ error: 'not_found' });
    return run(req, reply, async (c) => {
      const r = (await c.query<Row>(`${DOCUMENTS} WHERE d.type = $1 AND d.id = $2`, [type, id])).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      const row = documentRow(r);
      const view: AccountingDocumentView = {
        ...row,
        note: (r['note'] as string | null) ?? null,
        createdBy: (r['created_by'] as string | null) ?? null,
        createdAt: (r['created_at'] as Date).toISOString(),
        journal: await journalOf(c, row.type, row.id),
        canReverse:
          allowed(req, 'acc.journal.post') &&
          row.status === 'posted' &&
          row.reversedBy === null &&
          row.reverses === null,
      };
      return view;
    });
  });

  // ---- Receipts, expenses, transfers: posted when saved ----

  scope.post('/accounting/receipts', { preHandler: receipt }, async (req, reply) => {
    const parsed = CustomerReceiptRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const customer = await c.query(
        'SELECT 1 FROM erp.customer_accounts WHERE party_id = $1 AND deleted_at IS NULL',
        [b.customerId],
      );
      if (!customer.rowCount) throw new Refusal(400, { error: 'invalid_request' });
      await activeBank(c, b.bankAccountId);
      await checkMoney(
        c,
        {
          kind: 'receipt',
          date: b.receivedOn,
          amount: b.amount,
          customerId: b.customerId,
          bankAccountId: b.bankAccountId,
        },
        b.allowDuplicate,
      );
      const number = await nextNumber(c, req.auth!.tenantId, 'CR');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.customer_receipts (tenant_id, number, branch_id, customer_party_id, bank_account_id, amount,
           business_date, reference, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          req.auth!.tenantId,
          number,
          await shopBranch(c),
          b.customerId,
          b.bankAccountId,
          b.amount,
          b.receivedOn,
          b.reference,
          b.note,
        ],
      );
      await post(req, c, 'customer_receipt', rows[0]!.id);
      return new Created({ id: rows[0]!.id, number });
    });
  });

  scope.post('/accounting/expenses', { preHandler: expense }, async (req, reply) => {
    const parsed = ExpenseRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await activeCategory(c, b.categoryId);
      await activeBank(c, safeOf(b.paidFrom));
      await checkMoney(
        c,
        { kind: 'expense', date: b.paidOn, amount: b.amount, categoryId: b.categoryId, paidFrom: b.paidFrom },
        b.allowDuplicate,
      );
      const number = await nextNumber(c, req.auth!.tenantId, 'EX');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.expenses (tenant_id, number, branch_id, expense_category_id, paid_from_bank_account_id,
           amount, business_date, reference, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          req.auth!.tenantId,
          number,
          await shopBranch(c),
          b.categoryId,
          safeOf(b.paidFrom),
          b.amount,
          b.paidOn,
          b.reference,
          b.note,
        ],
      );
      await post(req, c, 'expense', rows[0]!.id);
      return new Created({ id: rows[0]!.id, number });
    });
  });

  scope.post('/accounting/transfers', { preHandler: transfer }, async (req, reply) => {
    const parsed = FundTransferRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await activeBank(c, safeOf(b.from));
      await activeBank(c, safeOf(b.to));
      await activeCategory(c, b.charges > 0 ? b.chargesCategoryId : null);
      await checkMoney(
        c,
        {
          kind: 'transfer',
          date: b.movedOn,
          amount: b.amount,
          from: b.from,
          to: b.to,
          charges: b.charges,
          chargesCategoryId: b.chargesCategoryId,
        },
        b.allowDuplicate,
      );
      const number = await nextNumber(c, req.auth!.tenantId, 'FT');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.fund_transfers (tenant_id, number, branch_id, from_bank_account_id, to_bank_account_id,
           amount, charges, charges_category_id, business_date, reference, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          req.auth!.tenantId,
          number,
          await shopBranch(c),
          safeOf(b.from),
          safeOf(b.to),
          b.amount,
          b.charges,
          b.charges > 0 ? b.chargesCategoryId : null,
          b.movedOn,
          b.reference,
          b.note,
        ],
      );
      await post(req, c, 'fund_transfer', rows[0]!.id);
      return new Created({ id: rows[0]!.id, number });
    });
  });

  // ---- Journal vouchers: drafts, then posted once ----

  const writeLines = async (c: Client, tenantId: string, id: string, lines: VoucherDraft['lines']) => {
    await c.query('DELETE FROM erp.journal_voucher_lines WHERE voucher_id = $1', [id]);
    for (const [i, l] of lines.entries())
      await c.query(
        `INSERT INTO erp.journal_voucher_lines (tenant_id, voucher_id, line_no, account_id, party_id, debit, credit, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, id, i + 1, l.accountId, l.partyId, l.debit, l.credit, l.memo ?? null],
      );
  };

  /** The draft, locked, at the version the screen saw; 409 when it moved on or was posted. */
  const draftAt = async (c: Client, id: string, rowVersion: string) => {
    const r = (
      await c.query<{ status: string; rv: string; by: string | null; at: Date }>(
        `SELECT v.status, v.row_version::text AS rv, u.full_name AS by, v.updated_at AS at
         FROM erp.journal_vouchers v LEFT JOIN erp.users u ON u.id = v.updated_by_user_id
         WHERE v.id = $1 AND v.reverses_id IS NULL FOR UPDATE OF v`,
        [id],
      )
    ).rows[0];
    if (!r) throw new Refusal(404, { error: 'not_found' });
    if (r.status === 'posted') throw new Refusal(409, { error: 'posted' });
    if (r.rv !== rowVersion)
      throw new Refusal(409, { error: 'stale', by: r.by, at: r.at.toISOString(), rowVersion: r.rv });
  };

  scope.post('/accounting/vouchers', { preHandler: journal }, async (req, reply) => {
    const parsed = VoucherDraft.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    // Nothing typed on any line is nothing to keep (owner's review of W1-19).
    if (isEmptyDraft(parsed.data.lines)) return reply.code(400).send({ error: 'empty_draft' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.journal_vouchers (tenant_id, branch_id, business_date, narration) VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [req.auth!.tenantId, await shopBranch(c), b.date, b.narration],
      );
      await writeLines(c, req.auth!.tenantId, rows[0]!.id, b.lines);
      return new Created({ id: rows[0]!.id });
    });
  });

  scope.get('/accounting/vouchers/:id', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const v = await voucherView(c, (req.params as { id: string }).id, now());
      if (!v) throw new Refusal(404, { error: 'not_found' });
      return v;
    }),
  );

  scope.put('/accounting/vouchers/:id', { preHandler: journal }, async (req, reply) => {
    const parsed = SaveVoucherRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const id = (req.params as { id: string }).id;
    return run(req, reply, async (c) => {
      await draftAt(c, id, b.rowVersion);
      // Nothing typed on any line is nothing to keep (owner's review of W1-19); posted or stale is said first.
      if (isEmptyDraft(b.lines)) throw new Refusal(400, { error: 'empty_draft' });
      await c.query(
        `UPDATE erp.journal_vouchers SET business_date = $2, narration = $3, row_version = row_version + 1
         WHERE id = $1`,
        [id, b.date, b.narration],
      );
      await writeLines(c, req.auth!.tenantId, id, b.lines);
      return voucherView(c, id, now());
    });
  });

  scope.delete('/accounting/vouchers/:id', { preHandler: journal }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rowVersion = param(req, 'rowVersion') || '';
    return run(req, reply, async (c) => {
      await draftAt(c, id, rowVersion);
      await c.query('DELETE FROM erp.journal_voucher_lines WHERE voucher_id = $1', [id]);
      await c.query('DELETE FROM erp.journal_vouchers WHERE id = $1', [id]);
      return { deleted: true };
    });
  });

  scope.post('/accounting/vouchers/:id/post', { preHandler: journal }, async (req, reply) => {
    const parsed = PostVoucherRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const id = (req.params as { id: string }).id;
    return run(req, reply, async (c) => {
      await draftAt(c, id, parsed.data.rowVersion);
      const v = (await voucherView(c, id, now()))!;
      if (v.check.problems.length > 0)
        throw new Refusal(400, { error: 'invalid', problems: v.check.problems });
      const number = await nextNumber(c, req.auth!.tenantId, 'JV');
      await c.query(
        `UPDATE erp.journal_vouchers SET status = 'posted', number = $2, posted_at = $3, posted_by_user_id = $4,
           row_version = row_version + 1 WHERE id = $1`,
        [id, number, now(), req.auth!.userId],
      );
      await post(req, c, 'journal_voucher', id);
      return { number };
    });
  });

  // A posted document reversed by a voucher that swaps its journal (rule 3, D-108); once, never a reversal itself.
  scope.post('/accounting/reverse', { preHandler: journal }, async (req, reply) => {
    const parsed = ReverseRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const original = (
        await c.query<{ branch_id: string; day: string; reverses: string | null; status: string | null }>(
          b.type === 'journal_voucher'
            ? 'SELECT branch_id, business_date::text AS day, reverses_id AS reverses, status FROM erp.journal_vouchers WHERE id = $1'
            : `SELECT branch_id, business_date::text AS day, NULL AS reverses, 'posted' AS status
               FROM erp.${TABLES[b.type]} WHERE id = $1`,
          [b.id],
        )
      ).rows[0];
      if (!original) throw new Refusal(404, { error: 'not_found' });
      if (original.reverses !== null || original.status !== 'posted')
        throw new Refusal(409, { error: 'not_reversible' });
      const posted = await c.query('SELECT 1 FROM erp.postings WHERE source_type = $1 AND source_id = $2', [
        b.type,
        b.id,
      ]);
      if (!posted.rowCount) throw new Refusal(409, { error: 'not_reversible' });
      const { today, lockDate } = await shopDay(c, now());
      const problem = checkDocumentDate(b.date, today, lockDate);
      if (problem) throw new Refusal(400, { error: 'invalid', problems: [problem] });
      if (b.date < original.day) throw new Refusal(400, { error: 'invalid', problems: ['before_original'] });
      const number = await nextNumber(c, req.auth!.tenantId, 'JV');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.journal_vouchers (tenant_id, number, branch_id, business_date, status, reverses_type,
           reverses_id, posted_at, posted_by_user_id) VALUES ($1, $2, $3, $4, 'posted', $5, $6, $7, $8) RETURNING id`,
        [req.auth!.tenantId, number, original.branch_id, b.date, b.type, b.id, now(), req.auth!.userId],
      );
      await post(req, c, 'journal_voucher', rows[0]!.id);
      return new Created({ id: rows[0]!.id, number });
    });
  });

  // ---- Periods and the lock date ----

  scope.get('/accounting/periods', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const t = (
        await c.query<{ start: number; fixed: boolean; first: string | null }>(
          `SELECT fiscal_year_start_month AS start, fiscal_year_locked AS fixed,
             (SELECT min(entry_date)::text FROM erp.postings) AS first FROM erp.tenants`,
        )
      ).rows[0]!;
      const { today, lockDate } = await shopDay(c, now());
      const earliest = [today, lockDate, t.first].filter((d): d is string => d !== null).sort()[0]!;
      const years: PeriodsView['years'] = [];
      for (let y = fiscalYearOf(earliest, t.start); y.start <= today;) {
        years.push({
          label: y.label,
          start: y.start,
          end: y.end,
          months: y.months.map((m) => ({ ...m, locked: lockDate !== null && m.end <= lockDate })),
        });
        const after = new Date(`${y.end}T00:00:00Z`);
        after.setUTCDate(after.getUTCDate() + 1);
        y = fiscalYearOf(after.toISOString().slice(0, 10), t.start);
      }
      let next: string | null;
      if (lockDate === null) {
        const lastMonth = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
        lastMonth.setUTCDate(0);
        next = lastMonth.toISOString().slice(0, 10);
      } else {
        const after = new Date(`${lockDate}T00:00:00Z`);
        after.setUTCDate(after.getUTCDate() + 1);
        const end = monthEnd(after.toISOString().slice(0, 10));
        next = end < today ? end : null;
      }
      const history = (
        await c.query<Row>(
          `SELECT a.at, u.full_name AS by, a.before, a.after FROM erp.audit_log a
           LEFT JOIN erp.users u ON u.id = a.user_id
           WHERE a.action IN ('period.lock', 'period.reopen', 'tenant.go_live') ORDER BY a.at DESC LIMIT 20`,
        )
      ).rows.map((r) => {
        const after = (r['after'] ?? {}) as { lockDate?: string; reason?: string | null };
        const before = (r['before'] ?? {}) as { lockDate?: string | null };
        return {
          at: (r['at'] as Date).toISOString(),
          by: (r['by'] as string | null) ?? null,
          from: before.lockDate ?? null,
          to: after.lockDate ?? '',
          reason: after.reason ?? null,
        };
      });
      const out: PeriodsView = {
        startMonth: t.start,
        startMonthFixed: t.fixed,
        lockDate,
        today,
        years,
        next,
        history,
      };
      return out;
    }),
  );

  // What still looks open on or before a date (owner answer 5): shown before locking, never blocking.
  scope.get('/accounting/periods/checklist', { preHandler: lock }, async (req, reply) => {
    const to = param(req, 'to') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return reply.code(400).send({ error: 'invalid_request' });
    return run(req, reply, async (c) => {
      const count = async (sql: string) => Number((await c.query<{ n: string }>(sql, [to])).rows[0]!.n);
      const balance = async (role: string) =>
        Number(
          (
            await c.query<{ b: string }>(
              `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
               JOIN erp.journal_entries e ON e.id = l.entry_id JOIN erp.accounts a ON a.id = l.account_id
               WHERE a.system_role = $2 AND e.entry_date <= $1`,
              [to, role],
            )
          ).rows[0]!.b,
        );
      const items: LockChecklist['items'] = [
        {
          kind: 'draft_vouchers',
          count: await count(
            "SELECT count(*) AS n FROM erp.journal_vouchers WHERE status = 'draft' AND business_date <= $1",
          ),
          amount: null,
        },
        {
          kind: 'draft_receipts',
          count: await count(
            "SELECT count(*) AS n FROM erp.goods_receipts WHERE status = 'draft' AND business_date <= $1",
          ),
          amount: null,
        },
        {
          kind: 'draft_returns',
          count: await count(
            "SELECT count(*) AS n FROM erp.purchase_returns WHERE status = 'draft' AND business_date <= $1",
          ),
          amount: null,
        },
        {
          kind: 'draft_transfers',
          count: await count(
            "SELECT count(*) AS n FROM erp.stock_transfers WHERE status IN ('draft', 'in_transit') AND business_date <= $1",
          ),
          amount: null,
        },
        {
          kind: 'draft_adjustments',
          count: await count(
            "SELECT count(*) AS n FROM erp.stock_adjustments WHERE status IN ('draft', 'awaiting_approval') AND business_date <= $1",
          ),
          amount: null,
        },
        {
          kind: 'open_exceptions',
          count: await count(
            "SELECT count(*) AS n FROM erp.exceptions WHERE status = 'open' AND business_date <= $1",
          ),
          amount: null,
        },
        { kind: 'suspense', count: 0, amount: await balance('SUSPENSE') },
        { kind: 'cash_in_transit', count: 0, amount: await balance('CASH_IN_TRANSIT') },
        {
          kind: 'open_sessions',
          count: await count(
            "SELECT count(*) AS n FROM erp.cash_sessions WHERE status = 'open' AND business_date <= $1",
          ),
          amount: null,
        },
      ];
      const out: LockChecklist = {
        lockDate: to,
        items: items.filter((i) => i.count > 0 || (i.amount !== null && i.amount !== 0)),
      };
      return out;
    });
  });

  scope.post('/accounting/lock', { preHandler: lock }, async (req, reply) => {
    const parsed = LockRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const current = (
        await c.query<{ lock_date: string | null }>('SELECT lock_date::text FROM erp.tenants FOR UPDATE')
      ).rows[0]!.lock_date;
      const { today } = await shopDay(c, now());
      const move = checkLockMove({
        current,
        proposed: b.lockDate,
        today,
        canReopen: allowed(req, 'acc.period.reopen'),
        reason: b.reason,
      });
      if (move.direction === 'forward' && !allowed(req, 'acc.period.close'))
        throw new Refusal(403, { error: 'forbidden' });
      if (move.problems.length > 0) throw new Refusal(400, { error: 'invalid', problems: move.problems });
      await c.query('UPDATE erp.tenants SET lock_date = $2, fiscal_year_locked = true WHERE id = $1', [
        req.auth!.tenantId,
        b.lockDate,
      ]);
      await c.query(
        `INSERT INTO erp.audit_log (tenant_id, user_id, request_id, action, entity, entity_id, before, after)
         VALUES ($1, $2, $3, $4, 'tenants', $1, $5, $6)`,
        [
          req.auth!.tenantId,
          req.auth!.userId,
          req.id,
          move.direction === 'back' ? 'period.reopen' : 'period.lock',
          JSON.stringify({ lockDate: current }),
          JSON.stringify({ lockDate: b.lockDate, reason: b.reason }),
        ],
      );
      return { lockDate: b.lockDate };
    });
  });

  // ---- Accounts: balances, ledgers, new accounts and expense categories ----

  scope.get('/accounting/accounts', { preHandler: financial }, async (req, reply) => {
    const at = param(req, 'at') || '';
    return run(req, reply, async (c) => {
      const rows = await accountRows(c);
      const own = await balances(c, /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : null);
      const children = new Map<string | null, string[]>();
      for (const a of rows) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a.id]);
      const total = (id: string): number =>
        (own.get(id) ?? 0) + (children.get(id) ?? []).reduce((s, ch) => s + total(ch), 0);
      return rows.map((a): AccountBalanceRow => ({ ...a, balance: total(a.id) }));
    });
  });

  scope.get('/accounting/accounts/:id/ledger', { preHandler: financial }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { from?: string; to?: string };
    const valid = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    return run(req, reply, async (c) => {
      const account = (await accountRows(c)).find((a) => a.id === id);
      if (!account) throw new Refusal(404, { error: 'not_found' });
      const { today } = await shopDay(c, now());
      const to = valid(q.to) ?? today;
      const from = valid(q.from) ?? `${to.slice(0, 8)}01`;
      const opening = Number(
        (
          await c.query<{ b: string }>(
            `SELECT coalesce(sum(l.debit - l.credit), 0)::text AS b FROM erp.journal_lines l
             JOIN erp.journal_entries e ON e.id = l.entry_id WHERE l.account_id = $1 AND e.entry_date < $2`,
            [id, from],
          )
        ).rows[0]!.b,
      );
      const LIMIT = 1000;
      const { rows } = await c.query<Row>(
        `SELECT e.entry_date::text AS date, e.number AS journal, x.source_type, x.source_id, e.memo, p.name AS party,
           l.debit::text AS debit, l.credit::text AS credit
         FROM erp.journal_lines l JOIN erp.journal_entries e ON e.id = l.entry_id
         JOIN erp.postings x ON x.seq = e.posting_seq LEFT JOIN erp.parties p ON p.id = l.party_id
         WHERE l.account_id = $1 AND e.entry_date BETWEEN $2 AND $3
         ORDER BY e.entry_date, e.posting_seq, l.line_no LIMIT ${LIMIT + 1}`,
        [id, from, to],
      );
      let balance = opening;
      const lines = rows.slice(0, LIMIT).map((r) => {
        const debit = Number(r['debit']);
        const credit = Number(r['credit']);
        balance += debit - credit;
        const memo = (r['memo'] as string | null) ?? null;
        return {
          date: r['date'] as string,
          journalNumber: r['journal'] as string,
          sourceType: r['source_type'] as string,
          sourceId: r['source_id'] as string,
          number: memo?.split(' ')[0] ?? null,
          memo,
          partyName: (r['party'] as string | null) ?? null,
          debit,
          credit,
          balance,
        };
      });
      const plain = plainAccount(account);
      const out: LedgerView = {
        account: plain,
        from,
        to,
        opening,
        lines,
        closing: balance,
        truncated: rows.length > LIMIT,
      };
      if ((req.query as { format?: string }).format !== 'csv') return out;
      // The ledger on the report frame downloads as CSV too (W2-01, D-116 answer 5).
      return sendCsv(
        reply,
        `ledger-${plain.code}-${from}-${to}.csv`,
        csv(
          ['date', 'journal', 'document', 'source', 'memo', 'party', 'debit', 'credit', 'balance'],
          [
            [from, '', '', 'opening', '', '', '', '', opening],
            ...lines.map((l): Cell[] => [
              l.date,
              l.journalNumber,
              l.number,
              l.sourceType,
              l.memo,
              l.partyName,
              l.debit,
              l.credit,
              l.balance,
            ]),
            [to, '', '', 'closing', '', '', '', '', balance],
          ],
        ),
      );
    });
  });

  scope.post('/accounting/accounts', { preHandler: chart }, async (req, reply) => {
    const parsed = CreateAccountRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      const rows = await accountRows(c);
      const parent = rows.find((a) => a.id === b.parentId);
      // A new account sits under a heading and is postable; roles stay a setup job (owner answer 4).
      if (!parent || parent.postable)
        throw new Refusal(400, { error: 'invalid', problems: ['parent_not_heading'] });
      const problems = validateChartOfAccounts([
        ...rows.map((a) => ({
          code: a.code,
          type: a.type,
          parentCode: rows.find((p) => p.id === a.parentId)?.code ?? null,
          isPostable: a.postable,
          systemRole: a.role,
        })),
        { code: b.code, type: parent.type, parentCode: parent.code, isPostable: true, systemRole: null },
      ]).filter((p) => 'account' in p && p.account === b.code);
      if (problems.length > 0)
        throw new Refusal(
          problems.some((p) => p.problem === 'duplicate_code') ? 409 : 400,
          problems.some((p) => p.problem === 'duplicate_code')
            ? { error: 'code_taken' }
            : { error: 'invalid', problems: problems.map((p) => p.problem) },
        );
      const { rows: made } = await c.query<{ id: string }>(
        `INSERT INTO erp.accounts (tenant_id, code, name, type, parent_id, is_postable) VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id`,
        [req.auth!.tenantId, b.code, b.name, parent.type, parent.id],
      );
      return new Created({ id: made[0]!.id });
    });
  });

  scope.patch('/accounting/accounts/:id', { preHandler: chart }, async (req, reply) => {
    const parsed = UpdateAccountRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const id = (req.params as { id: string }).id;
    return run(req, reply, async (c) => {
      const account = (await accountRows(c)).find((a) => a.id === id);
      if (!account) throw new Refusal(404, { error: 'not_found' });
      if (b.active === false && account.active) {
        // Only when nothing uses it but its own past lines, and those come to 0 (owner answer 4).
        const used = await c.query(
          `SELECT 1 FROM erp.accounts a WHERE a.id = $1 AND (a.system_role IS NOT NULL
             OR EXISTS (SELECT 1 FROM erp.bank_accounts b WHERE b.gl_account_id = a.id AND b.deleted_at IS NULL)
             OR EXISTS (SELECT 1 FROM erp.expense_categories k WHERE k.gl_account_id = a.id AND k.deleted_at IS NULL AND k.is_active)
             OR EXISTS (SELECT 1 FROM erp.accounts ch WHERE ch.parent_id = a.id AND ch.deleted_at IS NULL AND ch.is_active))`,
          [id],
        );
        if (used.rowCount) throw new Refusal(409, { error: 'in_use' });
        if (((await balances(c, null)).get(id) ?? 0) !== 0) throw new Refusal(409, { error: 'has_balance' });
      }
      await c.query(
        'UPDATE erp.accounts SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1',
        [id, b.name ?? null, b.active ?? null],
      );
      return { updated: true };
    });
  });

  /** A postable, active expense account, or 400. */
  const expenseAccount = async (c: Client, id: string) => {
    const r = await c.query(
      `SELECT 1 FROM erp.accounts WHERE id = $1 AND type = 'expense' AND is_postable AND is_active
         AND deleted_at IS NULL`,
      [id],
    );
    if (!r.rowCount) throw new Refusal(400, { error: 'invalid', problems: ['account_not_expense'] });
  };

  scope.post('/accounting/categories', { preHandler: chart }, async (req, reply) => {
    const parsed = CreateExpenseCategoryRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      await expenseAccount(c, b.accountId);
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO erp.expense_categories (tenant_id, code, name, gl_account_id) VALUES ($1, $2, $3, $4) RETURNING id`,
        [req.auth!.tenantId, b.code, b.name, b.accountId],
      );
      return new Created({ id: rows[0]!.id });
    });
  });

  scope.patch('/accounting/categories/:id', { preHandler: chart }, async (req, reply) => {
    const parsed = UpdateExpenseCategoryRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const id = (req.params as { id: string }).id;
    return run(req, reply, async (c) => {
      if (b.accountId) await expenseAccount(c, b.accountId);
      const r = await c.query(
        `UPDATE erp.expense_categories SET name = coalesce($2, name), gl_account_id = coalesce($3, gl_account_id),
           is_active = coalesce($4, is_active) WHERE id = $1 AND deleted_at IS NULL`,
        [id, b.name ?? null, b.accountId ?? null, b.active ?? null],
      );
      if (!r.rowCount) throw new Refusal(404, { error: 'not_found' });
      return { updated: true };
    });
  });
}
