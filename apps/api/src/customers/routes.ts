import {
  CreateCustomerRequest,
  UpdateCustomerRequest,
  type CustomerDetail,
  type CustomerLookups,
  type CustomerRow,
  type CustomerTerms,
} from '@erp/contracts';
import { withTenant } from '@erp/db';
import { can, DEFAULT_OFFLINE_DAILY_CAP, normalizePhone, type Permission } from '@erp/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type pg from 'pg';

import { requireAnyPermission, requirePermission } from '../auth/routes';
import { CUSTOMER_DELETABLE, IS_CUSTOMER, IS_SUPPLIER } from '../parties';
import { moneyOf } from '../reports/routes';

// Customers in the back office (W1-22 plan, D-109; POS-05, POS-07, CAT-04, PUR-01, ACC-03). A customer is a party
// with a live customer account (data model §3); the counters get every change through the W1-09 pull, whose cursor
// sees each written row. cust.edit adds and edits customers (owner answer 1); the tier and credit terms need
// cust.terms.edit, the owner's only (owner answer 2). Names and phones are personal data: never logged.

interface Deps {
  pool: pg.Pool;
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
type Row = Record<string, unknown>;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (x) => `\\${x}`);

/** Phones as the counter searches them (`normalizePhone`, W1-09); one that isn't a phone refuses the save. */
function phonesOf(list: string[] | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  const out: string[] = [];
  for (const p of list) {
    const n = normalizePhone(p);
    if (n === null) throw new Refusal(400, { error: 'phone_invalid' });
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Credit on needs a limit, or No limit ticked on purpose (owner answer 3). */
function checkTerms(t: CustomerTerms) {
  if (t.creditAllowed && t.creditLimit === null && t.noLimit !== true)
    throw new Refusal(400, { error: 'limit_required' });
}

const CUSTOMERS = `SELECT p.*, p.row_version::text AS rv, a.row_version::text AS av, a.price_tier_id, a.credit_allowed,
      a.credit_limit, a.offline_daily_cap, a.payment_terms_days, t.name AS tier_name,
      (${CUSTOMER_DELETABLE}) AS deletable, (${IS_SUPPLIER}) AS is_supplier,
      coalesce((SELECT sum(e.amount) FROM erp.party_ledger_entries e
                WHERE e.party_id = p.id AND e.role = 'customer'), 0) AS balance
    FROM erp.parties p
    JOIN erp.customer_accounts a ON a.party_id = p.id AND a.deleted_at IS NULL
    JOIN erp.price_tiers t ON t.id = a.price_tier_id
    WHERE p.deleted_at IS NULL`;

const customerRow = (r: Row): CustomerRow => ({
  id: r['id'] as string,
  code: r['code'] as string,
  name: r['name'] as string,
  phones: (r['phones'] as string[] | null) ?? [],
  city: (r['city'] as string | null) ?? null,
  tierId: r['price_tier_id'] as string,
  tierName: r['tier_name'] as string,
  creditAllowed: r['credit_allowed'] === true,
  creditLimit: num(r['credit_limit']),
  offlineDailyCap: Number(r['offline_daily_cap']),
  termsDays: num(r['payment_terms_days']),
  status: r['status'] as CustomerRow['status'],
  balance: Number(r['balance'] ?? 0),
  deletable: r['deletable'] === true,
  imported: r['legacy'] !== null && r['legacy'] !== undefined,
  supplier: r['is_supplier'] === true,
});

export function registerCustomers(scope: FastifyInstance, { pool, requireAuth }: Deps) {
  const read = requireAnyPermission(requireAuth, ['cust.edit', 'cust.terms.edit']);
  const edit = requirePermission(requireAuth, 'cust.edit');
  const allowed = (req: FastifyRequest, p: Permission) => can(req.auth!.grants, p, null);
  const needTerms = (req: FastifyRequest) => {
    if (!allowed(req, 'cust.terms.edit')) throw new Refusal(403, { error: 'forbidden' });
  };

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
      if (e.code === '23505' && e.constraint === 'parties_tenant_id_code_key')
        return reply.code(409).send({ error: 'code_taken' });
      if (e.code === '23503' || e.code === '22P02') return reply.code(400).send({ error: 'invalid_request' });
      throw err;
    }
  };

  const defaultTier = async (c: Client) => {
    const r = (
      await c.query<{ id: string }>(
        'SELECT id FROM erp.price_tiers WHERE is_default AND deleted_at IS NULL ORDER BY sort LIMIT 1',
      )
    ).rows[0];
    if (!r) throw new Refusal(409, { error: 'no_default_tier' });
    return r.id;
  };

  /** The account's columns from the terms, or a new customer's defaults (owner answer 3). */
  const accountValues = async (c: Client, t: CustomerTerms | undefined) =>
    t
      ? [t.tierId, t.creditAllowed, t.creditLimit, t.offlineDailyCap, t.termsDays]
      : [await defaultTier(c), false, null, DEFAULT_OFFLINE_DAILY_CAP, null];

  scope.get('/customers/lookups', { preHandler: read }, async (req, reply) =>
    run(req, reply, async (c) => {
      const live = (
        await c.query<{ live: boolean }>(
          'SELECT go_live_at IS NOT NULL AS live FROM erp.tenants WHERE id = $1',
          [req.auth!.tenantId],
        )
      ).rows[0]?.live;
      const out: CustomerLookups = {
        tiers: (
          await c.query<{ id: string; code: string; name: string; is_default: boolean }>(
            'SELECT id, code, name, is_default FROM erp.price_tiers WHERE deleted_at IS NULL ORDER BY sort, name',
          )
        ).rows.map((t) => ({ id: t.id, code: t.code, name: t.name, isDefault: t.is_default })),
        defaultOfflineDailyCap: DEFAULT_OFFLINE_DAILY_CAP,
        suppliers: (
          await c.query<{ id: string; code: string; name: string }>(
            `SELECT p.id, p.code, p.name FROM erp.parties p
             WHERE p.deleted_at IS NULL AND p.status = 'active' AND ${IS_SUPPLIER} AND NOT ${IS_CUSTOMER}
             ORDER BY lower(p.name)`,
          )
        ).rows,
        live: live === true,
        money: await moneyOf(c),
        can: { edit: allowed(req, 'cust.edit'), terms: allowed(req, 'cust.terms.edit') },
      };
      return out;
    }),
  );

  // The next free C code (owner answer 4): past the highest C number of any party, deleted ones too.
  scope.get('/customers/next-code', { preHandler: edit }, async (req, reply) =>
    run(req, reply, async (c) => {
      const top = (
        await c.query<{ n: string | null }>(
          `SELECT max(substring(code FROM 2)::bigint)::text AS n FROM erp.parties WHERE code ~* '^C[0-9]{1,12}$'`,
        )
      ).rows[0]!.n;
      const next = Number(top ?? 0) + 1;
      return { code: `C${String(next).padStart(4, '0')}` };
    }),
  );

  scope.get('/customers', { preHandler: read }, async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const text = (query['q'] ?? '').trim();
    const status = query['status'] === 'active' || query['status'] === 'inactive' ? query['status'] : '';
    const digits = text.replace(/\D/g, '');
    return run(req, reply, async (c) => {
      const { rows } = await c.query<Row>(
        `${CUSTOMERS}
         AND ($2 = '' OR p.status = $2)
         AND ($1 = '' OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%'
              OR p.city ILIKE '%' || $1 || '%'
              OR (length($3) >= 4 AND EXISTS (SELECT 1 FROM unnest(p.phones) ph
                                             WHERE regexp_replace(ph, '\\D', '', 'g') LIKE '%' || $3 || '%')))
         ORDER BY lower(p.name), p.code LIMIT 500`,
        [likeEscape(text), status, digits],
      );
      return { customers: rows.map(customerRow) };
    });
  });

  scope.get('/customers/:id', { preHandler: read }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (await c.query<Row>(`${CUSTOMERS} AND p.id = $1`, [id])).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      const entries = await c.query<Row>(
        `SELECT e.entry_date::text, e.due_date::text, e.source_type, e.source_id, e.amount,
           coalesce(s.number, v.number, pm.number, cr.number, jv.number, o.label, e.source_type) AS number
         FROM erp.party_ledger_entries e
         LEFT JOIN erp.sales_documents s ON e.source_type = 'sale' AND s.id = e.source_id
         LEFT JOIN erp.sales_voids v ON e.source_type = 'sales_void' AND v.id = e.source_id
         LEFT JOIN erp.payments pm ON e.source_type = 'payment' AND pm.id = e.source_id
         LEFT JOIN erp.customer_receipts cr ON e.source_type = 'customer_receipt' AND cr.id = e.source_id
         LEFT JOIN erp.journal_vouchers jv ON e.source_type = 'journal_voucher' AND jv.id = e.source_id
         LEFT JOIN erp.opening_balances o ON e.source_type = 'opening' AND o.id = e.source_id
         WHERE e.party_id = $1 AND e.role = 'customer'
         ORDER BY e.entry_date, e.posting_seq, e.id`,
        [id],
      );
      let running = 0;
      const ledger = entries.rows.map((e) => {
        running += Number(e['amount']);
        return {
          entryDate: e['entry_date'] as string,
          dueDate: e['due_date'] as string,
          kind: e['source_type'] as string,
          sourceId: e['source_id'] as string,
          number: e['number'] as string,
          amount: Number(e['amount']),
          balance: running,
        };
      });
      const out: CustomerDetail = {
        customer: {
          ...customerRow(r),
          contactPerson: (r['contact_person'] as string | null) ?? null,
          address: (r['address'] as string | null) ?? null,
          notes: (r['notes'] as string | null) ?? null,
          rowVersion: r['rv'] as string,
          accountVersion: r['av'] as string,
        },
        balance: running,
        ledger,
      };
      return out;
    });
  });

  scope.post('/customers', { preHandler: edit }, async (req, reply) => {
    const parsed = CreateCustomerRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      if (b.terms) {
        needTerms(req);
        checkTerms(b.terms);
      }
      const values = await accountValues(c, b.terms);
      let partyId: string;
      if ('partyId' in b) {
        // An existing supplier who also buys (owner answer 8): the same party gets a customer account.
        const p = (
          await c.query<{ id: string; live: boolean; dead: boolean }>(
            `SELECT p.id,
               EXISTS (SELECT 1 FROM erp.customer_accounts a WHERE a.party_id = p.id AND a.deleted_at IS NULL) AS live,
               EXISTS (SELECT 1 FROM erp.customer_accounts a WHERE a.party_id = p.id AND a.deleted_at IS NOT NULL)
                 AS dead
             FROM erp.parties p WHERE p.id = $1 AND p.deleted_at IS NULL AND ${IS_SUPPLIER}`,
            [b.partyId],
          )
        ).rows[0];
        if (!p) throw new Refusal(404, { error: 'not_found' });
        if (p.live) throw new Refusal(409, { error: 'already_customer' });
        partyId = p.id;
        if (p.dead) {
          // An account deleted earlier comes back (the counters' trigger re-sends the party).
          await c.query(
            `UPDATE erp.customer_accounts SET deleted_at = NULL, price_tier_id = $2, credit_allowed = $3,
               credit_limit = $4, offline_daily_cap = $5, payment_terms_days = $6 WHERE party_id = $1`,
            [partyId, ...values],
          );
          return new Created({ id: partyId });
        }
      } else {
        if ((await c.query('SELECT 1 FROM erp.parties WHERE lower(code) = lower($1)', [b.code])).rowCount)
          throw new Refusal(409, { error: 'code_taken' });
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO erp.parties (tenant_id, code, name, contact_person, phones, address, city, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            req.auth!.tenantId,
            b.code,
            b.name,
            b.contactPerson ?? null,
            phonesOf(b.phones) ?? [],
            b.address ?? null,
            b.city ?? null,
            b.notes ?? null,
          ],
        );
        partyId = rows[0]!.id;
      }
      await c.query(
        `INSERT INTO erp.customer_accounts (tenant_id, party_id, price_tier_id, credit_allowed, credit_limit,
           offline_daily_cap, payment_terms_days) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.auth!.tenantId, partyId, ...values],
      );
      return new Created({ id: partyId });
    });
  });

  scope.patch('/customers/:id', { preHandler: edit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateCustomerRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    return run(req, reply, async (c) => {
      if (b.terms) {
        needTerms(req);
        checkTerms(b.terms);
      }
      const cur = (
        await c.query<Row>(
          `SELECT p.*, p.row_version::text AS rv, a.row_version::text AS av, u.full_name AS by, ua.full_name AS aby
           FROM erp.parties p
           JOIN erp.customer_accounts a ON a.party_id = p.id AND a.deleted_at IS NULL
           LEFT JOIN erp.users u ON u.id = p.updated_by_user_id
           LEFT JOIN erp.users ua ON ua.id = a.updated_by_user_id
           WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [id],
        )
      ).rows[0];
      if (!cur) throw new Refusal(404, { error: 'not_found' });
      if (cur['rv'] !== b.rowVersion) throw new Refusal(409, { error: 'stale', by: cur['by'] ?? null });
      if (b.terms && cur['av'] !== b.accountVersion)
        throw new Refusal(409, { error: 'stale', by: cur['aby'] ?? null });
      // A customer who owes (or has paid in advance) stays active, so the desk can still collect (owner answer 5).
      if (b.status === 'inactive' && cur['status'] !== 'inactive') {
        const balance = Number(
          (
            await c.query<{ b: string }>(
              `SELECT coalesce(sum(amount), 0)::text AS b FROM erp.party_ledger_entries
               WHERE party_id = $1 AND role = 'customer'`,
              [id],
            )
          ).rows[0]!.b,
        );
        if (balance !== 0) throw new Refusal(409, { error: 'balance_open', balance });
      }
      const phones = phonesOf(b.phones);
      const pick = (v: unknown, col: string) => (v !== undefined ? v : cur[col]);
      const { rows } = await c.query<{ rv: string }>(
        `UPDATE erp.parties SET name = $2, contact_person = $3, phones = $4, address = $5, city = $6, notes = $7,
           status = $8 WHERE id = $1 RETURNING row_version::text AS rv`,
        [
          id,
          pick(b.name, 'name'),
          pick(b.contactPerson, 'contact_person'),
          pick(phones, 'phones'),
          pick(b.address, 'address'),
          pick(b.city, 'city'),
          pick(b.notes, 'notes'),
          pick(b.status, 'status'),
        ],
      );
      let accountVersion = cur['av'] as string;
      if (b.terms) {
        const t = b.terms;
        const a = await c.query<{ av: string }>(
          `UPDATE erp.customer_accounts SET price_tier_id = $2, credit_allowed = $3, credit_limit = $4,
             offline_daily_cap = $5, payment_terms_days = $6
           WHERE party_id = $1 AND deleted_at IS NULL RETURNING row_version::text AS av`,
          [id, t.tierId, t.creditAllowed, t.creditLimit, t.offlineDailyCap, t.termsDays],
        );
        accountVersion = a.rows[0]!.av;
      }
      return { rowVersion: rows[0]!.rv, accountVersion };
    });
  });

  // A customer added by mistake: only one never used as a customer; marked deleted (rule 8). A party that is also a
  // supplier keeps its party row and loses only the customer account (owner answer 5).
  scope.delete('/customers/:id', { preHandler: edit }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return run(req, reply, async (c) => {
      const r = (
        await c.query<{ deletable: boolean; supplier: boolean }>(
          `SELECT (${CUSTOMER_DELETABLE}) AS deletable, (${IS_SUPPLIER}) AS supplier FROM erp.parties p
           WHERE p.id = $1 AND p.deleted_at IS NULL AND ${IS_CUSTOMER}`,
          [id],
        )
      ).rows[0];
      if (!r) throw new Refusal(404, { error: 'not_found' });
      if (!r.deletable) throw new Refusal(409, { error: 'in_use' });
      await c.query('UPDATE erp.customer_accounts SET deleted_at = now() WHERE party_id = $1', [id]);
      if (!r.supplier) await c.query('UPDATE erp.parties SET deleted_at = now() WHERE id = $1', [id]);
      return { deleted: true };
    });
  });
}
