import type { TenantSpec } from '@erp/contracts';
import {
  ROLE_TEMPLATES,
  validateChartOfAccounts,
  type ChartAccount,
  type RoleTemplateKey,
} from '@erp/domain';
import pg from 'pg';

import retail from '../../templates/retail-coa.json';

// The tenant setup command (PLT-11, D-083): creates whatever the spec lists and the database lacks, and never
// changes what exists. A value that differs is reported as drift; changing a live shop is a back-office action.

export interface SetupOptions {
  /** Argon2id hash of the owner's password, used only when the owner user is created. */
  ownerPasswordHash: string;
  mustChangePassword: boolean;
}

export interface SetupReport {
  tenantId: string;
  /** What this run created, e.g. `account 1150`. Empty when nothing was missing. */
  created: string[];
  /** Settings this run changed to match the spec: only a payment method's bank account (W1-08), e.g.
   * `payment method raast bank account: hbl → soneri`. */
  updated: string[];
  /** Spec values that differ from the database, which were left as they are. */
  drift: string[];
  /** Setup that's still incomplete, e.g. a payment method without an account. */
  needsAttention: string[];
}

export class TenantSpecError extends Error {
  constructor(readonly problems: string[]) {
    super(`tenant spec is not valid:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

const TEMPLATES = { retail } as const;

/** "Cash and bank": every bank, wallet and card-clearing account sits under it (posting rules §2). */
const CASH_AND_BANK = '1100';

const ROLE_NAMES: Record<RoleTemplateKey, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  salesman: 'Salesman',
  purchaser: 'Purchaser',
  accountant: 'Accountant',
};

type Row = Record<string, unknown>;
interface NamedAccount extends ChartAccount {
  name: string;
}

/** The full chart the spec asks for: the template plus one asset account per bank, wallet or card clearing. */
function chartFor(spec: TenantSpec): NamedAccount[] {
  return [
    ...TEMPLATES[spec.chartTemplate].accounts,
    ...spec.bankAccounts.map((b) => ({
      code: b.accountCode,
      name: b.name,
      type: 'asset',
      parentCode: CASH_AND_BANK,
      isPostable: true,
      systemRole: null,
    })),
  ];
}

/** Everything wrong with a spec, checked before anything is written. */
export function specProblems(spec: TenantSpec): string[] {
  const chart = chartFor(spec);
  const problems = validateChartOfAccounts(chart).map((p) =>
    'role' in p ? `chart: ${p.problem} ${p.role}` : `chart: ${p.problem} ${p.account}`,
  );
  const unique = (what: string, codes: string[]) => {
    const seen = new Set<string>();
    for (const c of codes) {
      if (seen.has(c)) problems.push(`${what} ${c} is listed twice`);
      seen.add(c);
    }
  };
  unique(
    'location',
    spec.locations.map((l) => l.code),
  );
  unique(
    'bank account',
    spec.bankAccounts.map((b) => b.code),
  );
  unique(
    'payment method',
    spec.paymentMethods.map((m) => m.code),
  );
  unique(
    'price tier',
    spec.priceTiers.map((t) => t.code),
  );
  unique(
    'tax code',
    spec.taxCodes.map((t) => t.code),
  );
  unique(
    'expense category',
    spec.expenseCategories.map((e) => e.code),
  );

  const banks = new Set(spec.bankAccounts.map((b) => b.code));
  for (const m of spec.paymentMethods) {
    if (m.bankAccount === null) continue;
    if (m.code === 'cash' || m.code === 'on_account')
      problems.push(`payment method ${m.code} can't have a bank account`);
    else if (!banks.has(m.bankAccount))
      problems.push(`payment method ${m.code}: unknown bank account ${m.bankAccount}`);
  }
  if (!spec.paymentMethods.some((m) => m.code === 'cash')) problems.push('payment method cash is missing');
  const defaults = spec.priceTiers.filter((t) => t.isDefault).length;
  if (defaults !== 1) problems.push(`price tiers: ${defaults} defaults, need exactly 1`);
  for (const e of spec.expenseCategories) {
    const account = chart.find((a) => a.code === e.accountCode);
    if (!account?.isPostable || account.type !== 'expense')
      problems.push(`expense category ${e.code}: ${e.accountCode} is not a postable expense account`);
  }
  return problems;
}

/** JSON with sorted keys, so two equal objects compare equal. */
const canonical = (v: unknown): string =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
        .join(',')}}`
    : JSON.stringify(v);
/** Codes, numbers and times as they are; free text quoted. */
const show = (v: unknown) =>
  v === null || v === undefined
    ? 'none'
    : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? String(v)
      : canonical(v);
const quote = (v: unknown) => (v === null || v === undefined ? 'none' : JSON.stringify(v));

/**
 * Creates the tenant described by `spec`, or completes it, in one transaction as the owner role (`ownerUrl`,
 * the migrations role: erp_app may not create tenants). Safe to run again: it only creates what's missing.
 */
export async function setupTenant(
  ownerUrl: string,
  spec: TenantSpec,
  opts: SetupOptions,
): Promise<SetupReport> {
  const problems = specProblems(spec);
  if (problems.length > 0) throw new TenantSpecError(problems);

  const created: string[] = [];
  const drift: string[] = [];
  const differs = (what: string, field: string, database: unknown, wanted: unknown, fmt = show) => {
    if (canonical(database ?? null) !== canonical(wanted ?? null))
      drift.push(`${what} ${field}: database ${fmt(database)}, spec ${fmt(wanted)}`);
  };

  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const one = async (sql: string, params: unknown[]) => (await c.query<Row>(sql, params)).rows[0];

    // The tenant: found by its shop code, or created with a new id.
    const listed = await one('SELECT tenant_id FROM erp.tenant_directory WHERE code = $1', [spec.code]);
    const tenantId = listed
      ? (listed.tenant_id as string)
      : ((await one('SELECT erp.uuid_v7() AS id', []))!.id as string);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);

    const tenant = await one('SELECT * FROM erp.tenants WHERE id = $1', [tenantId]);
    if (!tenant) {
      await c.query(
        `INSERT INTO erp.tenants (id, name, legal_name, base_currency, currency_minor_units, timezone, locale,
           fiscal_year_start_month, tax_mode, cash_rounding_increment, day_cutoff_hour, closing_time,
           cash_handover_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          tenantId,
          spec.name,
          spec.legalName,
          spec.baseCurrency,
          spec.currencyMinorUnits,
          spec.timezone,
          spec.locale,
          spec.fiscalYearStartMonth,
          spec.taxMode,
          spec.cashRoundingIncrement,
          spec.dayCutoffHour,
          spec.closingTime,
          spec.cashHandoverMode,
        ],
      );
      created.push(`tenant ${spec.code}`);
    } else {
      differs('tenant', 'name', tenant.name, spec.name, quote);
      differs('tenant', 'legal_name', tenant.legal_name, spec.legalName, quote);
      differs('tenant', 'base_currency', tenant.base_currency, spec.baseCurrency);
      differs('tenant', 'currency_minor_units', tenant.currency_minor_units, spec.currencyMinorUnits);
      differs('tenant', 'timezone', tenant.timezone, spec.timezone);
      differs('tenant', 'locale', tenant.locale, spec.locale);
      differs('tenant', 'fiscal_year_start_month', tenant.fiscal_year_start_month, spec.fiscalYearStartMonth);
      differs('tenant', 'tax_mode', tenant.tax_mode, spec.taxMode);
      differs(
        'tenant',
        'cash_rounding_increment',
        Number(tenant.cash_rounding_increment),
        spec.cashRoundingIncrement,
      );
      differs('tenant', 'day_cutoff_hour', tenant.day_cutoff_hour, spec.dayCutoffHour);
      differs('tenant', 'closing_time', (tenant.closing_time as string).slice(0, 5), spec.closingTime);
      differs('tenant', 'cash_handover_mode', tenant.cash_handover_mode, spec.cashHandoverMode);
    }
    if (!listed) {
      await c.query('INSERT INTO erp.tenant_directory (code, tenant_id) VALUES ($1, $2)', [
        spec.code,
        tenantId,
      ]);
      created.push(`login code ${spec.code}`);
    }

    // The branch and its locations.
    const b = spec.branch;
    let branch = await one('SELECT * FROM erp.branches WHERE tenant_id = $1 AND code = $2', [
      tenantId,
      b.code,
    ]);
    if (!branch) {
      branch = await one(
        `INSERT INTO erp.branches (tenant_id, code, name, address, phone, receipt_header)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, b.code, b.name, b.address ?? null, b.phone ?? null, b.receiptHeader],
      );
      created.push(`branch ${b.code}`);
    } else {
      differs(`branch ${b.code}`, 'name', branch.name, b.name, quote);
      differs(`branch ${b.code}`, 'address', branch.address, b.address ?? null, quote);
      differs(`branch ${b.code}`, 'phone', branch.phone, b.phone ?? null, quote);
      differs(`branch ${b.code}`, 'receipt_header', branch.receipt_header, b.receiptHeader, canonical);
    }
    const branchId = branch!.id as string;
    for (const l of spec.locations) {
      const row = await one(
        'SELECT * FROM erp.locations WHERE tenant_id = $1 AND branch_id = $2 AND code = $3',
        [tenantId, branchId, l.code],
      );
      if (!row) {
        await c.query(
          'INSERT INTO erp.locations (tenant_id, branch_id, code, name, kind, is_sellable) VALUES ($1, $2, $3, $4, $5, $6)',
          [tenantId, branchId, l.code, l.name, l.kind, l.isSellable],
        );
        created.push(`location ${l.code}`);
      } else {
        differs(`location ${l.code}`, 'name', row.name, l.name, quote);
        differs(`location ${l.code}`, 'kind', row.kind, l.kind);
        differs(`location ${l.code}`, 'is_sellable', row.is_sellable, l.isSellable);
      }
    }

    // The chart of accounts, parents before children.
    const existing = new Map(
      (
        await c.query<Row>(
          `SELECT a.*, p.code AS parent_code FROM erp.accounts a LEFT JOIN erp.accounts p ON p.id = a.parent_id
           WHERE a.tenant_id = $1`,
          [tenantId],
        )
      ).rows.map((r) => [r.code as string, r]),
    );
    const accountIds = new Map([...existing].map(([code, r]) => [code, r.id as string]));
    const chart = chartFor(spec);
    const depth = (a: NamedAccount): number => {
      const parent = a.parentCode === null ? undefined : chart.find((p) => p.code === a.parentCode);
      return parent ? depth(parent) + 1 : 0;
    };
    for (const a of [...chart].sort((x, y) => depth(x) - depth(y))) {
      const row = existing.get(a.code);
      if (!row) {
        const ins = await one(
          `INSERT INTO erp.accounts (tenant_id, code, name, type, parent_id, is_postable, system_role)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            tenantId,
            a.code,
            a.name,
            a.type,
            a.parentCode === null ? null : accountIds.get(a.parentCode),
            a.isPostable,
            a.systemRole,
          ],
        );
        accountIds.set(a.code, ins!.id as string);
        created.push(`account ${a.code}`);
      } else {
        differs(`account ${a.code}`, 'name', row.name, a.name, quote);
        differs(`account ${a.code}`, 'type', row.type, a.type);
        differs(`account ${a.code}`, 'parent', row.parent_code, a.parentCode);
        differs(`account ${a.code}`, 'is_postable', row.is_postable, a.isPostable);
        differs(`account ${a.code}`, 'system_role', row.system_role, a.systemRole);
      }
    }

    // Banks, wallets and card clearing.
    const bankIds = new Map<string, string>();
    for (const bank of spec.bankAccounts) {
      const row = await one(
        `SELECT b.*, a.code AS account_code FROM erp.bank_accounts b JOIN erp.accounts a ON a.id = b.gl_account_id
         WHERE b.tenant_id = $1 AND b.code = $2`,
        [tenantId, bank.code],
      );
      if (!row) {
        const ins = await one(
          'INSERT INTO erp.bank_accounts (tenant_id, code, name, kind, gl_account_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
          [tenantId, bank.code, bank.name, bank.kind, accountIds.get(bank.accountCode)],
        );
        bankIds.set(bank.code, ins!.id as string);
        created.push(`bank account ${bank.code}`);
      } else {
        bankIds.set(bank.code, row.id as string);
        differs(`bank account ${bank.code}`, 'name', row.name, bank.name, quote);
        differs(`bank account ${bank.code}`, 'kind', row.kind, bank.kind);
        differs(`bank account ${bank.code}`, 'account', row.account_code, bank.accountCode);
      }
    }

    // Payment methods: cash and on-account have no account; every other method needs a reference (ACC-08).
    for (const [i, m] of spec.paymentMethods.entries()) {
      const row = await one(
        `SELECT pm.*, b.code AS bank_code FROM erp.payment_methods pm
         LEFT JOIN erp.bank_accounts b ON b.id = pm.bank_account_id WHERE pm.tenant_id = $1 AND pm.code = $2`,
        [tenantId, m.code],
      );
      if (!row) {
        await c.query(
          `INSERT INTO erp.payment_methods (tenant_id, code, name, is_cash, requires_reference, bank_account_id, sort)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tenantId,
            m.code,
            m.name,
            m.code === 'cash',
            m.code !== 'cash' && m.code !== 'on_account',
            m.bankAccount === null ? null : bankIds.get(m.bankAccount),
            i + 1,
          ],
        );
        created.push(`payment method ${m.code}`);
      } else {
        differs(`payment method ${m.code}`, 'name', row.name, m.name, quote);
        differs(`payment method ${m.code}`, 'bank account', row.bank_code, m.bankAccount);
      }
    }

    for (const [i, t] of spec.priceTiers.entries()) {
      const row = await one('SELECT * FROM erp.price_tiers WHERE tenant_id = $1 AND code = $2', [
        tenantId,
        t.code,
      ]);
      if (!row) {
        await c.query(
          'INSERT INTO erp.price_tiers (tenant_id, code, name, sort, is_default) VALUES ($1, $2, $3, $4, $5)',
          [tenantId, t.code, t.name, i + 1, t.isDefault],
        );
        created.push(`price tier ${t.code}`);
      } else {
        differs(`price tier ${t.code}`, 'name', row.name, t.name, quote);
        differs(`price tier ${t.code}`, 'is_default', row.is_default, t.isDefault);
      }
    }

    for (const t of spec.taxCodes) {
      const row = await one('SELECT * FROM erp.tax_codes WHERE tenant_id = $1 AND code = $2', [
        tenantId,
        t.code,
      ]);
      if (!row) {
        await c.query('INSERT INTO erp.tax_codes (tenant_id, code, name, rate_bp) VALUES ($1, $2, $3, $4)', [
          tenantId,
          t.code,
          t.name,
          t.rateBp,
        ]);
        created.push(`tax code ${t.code}`);
      } else {
        differs(`tax code ${t.code}`, 'name', row.name, t.name, quote);
        differs(`tax code ${t.code}`, 'rate_bp', row.rate_bp, t.rateBp);
      }
    }

    for (const e of spec.expenseCategories) {
      const row = await one(
        `SELECT e.*, a.code AS account_code FROM erp.expense_categories e JOIN erp.accounts a ON a.id = e.gl_account_id
         WHERE e.tenant_id = $1 AND e.code = $2`,
        [tenantId, e.code],
      );
      if (!row) {
        await c.query(
          'INSERT INTO erp.expense_categories (tenant_id, code, name, gl_account_id) VALUES ($1, $2, $3, $4)',
          [tenantId, e.code, e.name, accountIds.get(e.accountCode)],
        );
        created.push(`expense category ${e.code}`);
      } else {
        differs(`expense category ${e.code}`, 'name', row.name, e.name, quote);
        differs(`expense category ${e.code}`, 'account', row.account_code, e.accountCode);
      }
    }

    // The print profile every device uses unless it has its own (D-055).
    const p = spec.printProfile;
    const profile = await one(
      'SELECT * FROM erp.print_profiles WHERE tenant_id = $1 AND lower(name) = lower($2)',
      [tenantId, p.name],
    );
    if (!profile) {
      const hasDefault = await one(
        'SELECT 1 FROM erp.print_profiles WHERE tenant_id = $1 AND is_tenant_default AND deleted_at IS NULL',
        [tenantId],
      );
      await c.query(
        `INSERT INTO erp.print_profiles (tenant_id, name, paper_format, code_type, copies, template_options,
           is_tenant_default) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, p.name, p.paperFormat, p.codeType, p.copies, p.templateOptions, !hasDefault],
      );
      created.push(`print profile ${JSON.stringify(p.name)}`);
    } else {
      const what = `print profile ${JSON.stringify(p.name)}`;
      differs(what, 'paper_format', profile.paper_format, p.paperFormat);
      differs(what, 'code_type', profile.code_type, p.codeType);
      differs(what, 'copies', profile.copies, p.copies);
      differs(what, 'template_options', profile.template_options, p.templateOptions, canonical);
    }

    // The six role templates (D-081); a role already made from a template is left as the owner edited it.
    const roleIds = new Map(
      (
        await c.query<Row>(
          'SELECT id, template_key FROM erp.roles WHERE tenant_id = $1 AND template_key IS NOT NULL',
          [tenantId],
        )
      ).rows.map((r) => [r.template_key as string, r.id as string]),
    );
    for (const key of Object.keys(ROLE_TEMPLATES) as RoleTemplateKey[]) {
      if (roleIds.has(key)) continue;
      const t = ROLE_TEMPLATES[key];
      const ins = await one(
        'INSERT INTO erp.roles (tenant_id, name, template_key, permissions, limits) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [tenantId, ROLE_NAMES[key], key, t.permissions, t.limits],
      );
      roleIds.set(key, ins!.id as string);
      created.push(`role ${ROLE_NAMES[key]}`);
    }

    // The owner. An existing owner keeps their password: the setup never resets one.
    const o = spec.owner;
    const user = await one('SELECT * FROM erp.users WHERE tenant_id = $1 AND lower(username) = lower($2)', [
      tenantId,
      o.username,
    ]);
    let userId: string;
    if (!user) {
      const ins = await one(
        `INSERT INTO erp.users (tenant_id, username, full_name, password_hash, must_change_password, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
        [tenantId, o.username, o.fullName, opts.ownerPasswordHash, opts.mustChangePassword],
      );
      userId = ins!.id as string;
      created.push(`user ${o.username}`);
    } else {
      userId = user.id as string;
      differs(`user ${o.username}`, 'full_name', user.full_name, o.fullName, quote);
    }
    const ownerRole = roleIds.get('owner')!;
    const hasRole = await one(
      'SELECT 1 FROM erp.user_roles WHERE tenant_id = $1 AND user_id = $2 AND role_id = $3 AND deleted_at IS NULL',
      [tenantId, userId, ownerRole],
    );
    if (!hasRole) {
      await c.query('INSERT INTO erp.user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)', [
        tenantId,
        userId,
        ownerRole,
      ]);
      created.push(`role Owner for ${o.username}`);
    }

    // What the database still lacks, whatever the spec says: a non-cash method that can't be posted yet.
    const unmapped = await c.query<{ code: string }>(
      `SELECT code FROM erp.payment_methods
       WHERE tenant_id = $1 AND bank_account_id IS NULL AND code NOT IN ('cash', 'on_account') AND deleted_at IS NULL
       ORDER BY code`,
      [tenantId],
    );
    const needsAttention = unmapped.rows.map((r) => `payment method ${r.code} has no account yet`);

    await c.query('COMMIT');
    return { tenantId, created, updated: [], drift, needsAttention };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

/**
 * Support reset (D-083, the W0-11 plan's risks): a temporary password that must be changed at the next login.
 * Also lifts a lockout and ends the user's sessions. Runs as the owner role, like the setup.
 */
export async function resetUserPassword(
  ownerUrl: string,
  tenantCode: string,
  username: string,
  { passwordHash }: { passwordHash: string },
): Promise<void> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    const dir = await c.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
      [tenantCode],
    );
    const tenantId = dir.rows[0]?.tenant_id;
    if (!tenantId) throw new Error(`no shop ${tenantCode}`);
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const user = await c.query<{ id: string }>(
      `UPDATE erp.users SET password_hash = $1, must_change_password = true, password_changed_at = now()
       WHERE tenant_id = $2 AND lower(username) = lower($3) AND deleted_at IS NULL RETURNING id`,
      [passwordHash, tenantId, username],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error(`no user ${username} in ${tenantCode}`);
    await c.query(
      'UPDATE erp.user_login_state SET failed_logins = 0, locked_until = NULL WHERE user_id = $1',
      [userId],
    );
    await c.query('UPDATE erp.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [
      userId,
    ]);
    await c.query(
      `INSERT INTO erp.audit_log (tenant_id, action, entity, entity_id, after)
       VALUES ($1, 'password.reset', 'user', $2, $3)`,
      [tenantId, userId, { username, by: 'support' }],
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}
