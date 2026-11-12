import { TenantSpec } from '@erp/contracts';
import { REQUIRED_SYSTEM_ROLES } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../../infra/db/tenants/delux.json';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { resetUserPassword, setupTenant, type SetupReport } from './tenant';

// The tenant setup command (PLT-11, ACC-01, ACC-08, POS-16, D-083), run on the real Delux spec.

let db: TestDatabase;
let admin: pg.Client;
let first: SetupReport;
let tenantId: string;
const spec = TenantSpec.parse(deluxSpec);

const q = async <T extends pg.QueryResultRow>(sql: string) =>
  (await admin.query<T>(sql.replaceAll(':tenant', `'${tenantId}'`))).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  first = await setupTenant(db.ownerUrl, spec, {
    ownerPasswordHash: 'argon2-hash-from-the-api',
    mustChangePassword: false,
  });
  tenantId = first.tenantId;
});

afterAll(async () => {
  await admin?.end();
  await db?.drop();
});

describe('setting up Delux', () => {
  it('creates the tenant with the reviewed settings and the login directory entry', async () => {
    const [t] = await q<Record<string, unknown>>('SELECT * FROM erp.tenants WHERE id = :tenant');
    expect(t).toMatchObject({
      name: 'Delux Autos',
      base_currency: 'PKR',
      currency_minor_units: 2,
      timezone: 'Asia/Karachi',
      fiscal_year_start_month: 1,
      tax_mode: 'none',
      cash_rounding_increment: '100',
      day_cutoff_hour: 4,
      closing_time: '20:00:00',
      cash_handover_mode: 'required',
    });
    expect(await q('SELECT code FROM erp.tenant_directory WHERE tenant_id = :tenant')).toEqual([
      { code: 'delux' },
    ]);
  });

  it('creates the branch with Shop, Godown and Damaged, and its In transit location (W1-18)', async () => {
    const rows = await q<{ code: string; kind: string; is_sellable: boolean }>(
      'SELECT code, kind, is_sellable FROM erp.locations WHERE tenant_id = :tenant ORDER BY code',
    );
    expect(rows).toEqual([
      { code: 'DAMAGED', kind: 'damaged', is_sellable: false },
      { code: 'GODOWN', kind: 'storage', is_sellable: false },
      { code: 'SHOP', kind: 'shop', is_sellable: true },
      { code: 'TRANSIT', kind: 'transit', is_sellable: false },
    ]);
  });

  it('maps every required system role exactly once', async () => {
    const rows = await q<{ system_role: string; n: number }>(
      `SELECT system_role, count(*)::int AS n FROM erp.accounts
       WHERE tenant_id = :tenant AND system_role IS NOT NULL GROUP BY 1`,
    );
    for (const role of REQUIRED_SYSTEM_ROLES)
      expect(rows.find((r) => r.system_role === role)?.n, role).toBe(1);
  });

  it('has a Posting suspense account for bills that do not add up (owner answer 3 to W1-08)', async () => {
    expect(
      await q(
        "SELECT code, name, type, is_postable FROM erp.accounts WHERE tenant_id = :tenant AND system_role = 'SUSPENSE'",
      ),
    ).toEqual([{ code: '1190', name: 'Posting suspense', type: 'asset', is_postable: true }]);
  });

  it('creates the banks and wallets, and maps the non-cash payment methods to them', async () => {
    const rows = await q<{
      code: string;
      bank: string | null;
      requires_reference: boolean;
      is_cash: boolean;
    }>(
      `SELECT pm.code, b.code AS bank, pm.requires_reference, pm.is_cash FROM erp.payment_methods pm
       LEFT JOIN erp.bank_accounts b ON b.id = pm.bank_account_id WHERE pm.tenant_id = :tenant ORDER BY pm.code`,
    );
    expect(rows).toEqual([
      { code: 'bank_transfer', bank: 'hbl', requires_reference: true, is_cash: false },
      { code: 'card', bank: 'card', requires_reference: true, is_cash: false },
      { code: 'cash', bank: null, requires_reference: false, is_cash: true },
      { code: 'easypaisa', bank: 'easypaisa', requires_reference: true, is_cash: false },
      { code: 'jazzcash', bank: 'jazzcash', requires_reference: true, is_cash: false },
      { code: 'on_account', bank: null, requires_reference: false, is_cash: false },
      { code: 'raast', bank: 'hbl', requires_reference: true, is_cash: false },
    ]);
  });

  it('has nothing left needing attention: Raast and bank transfer go to HBL (owner answer 1 to W1-08)', () => {
    expect(first.needsAttention).toEqual([]);
  });

  it('creates the tiers (Retail by default), the 0% tax code, the roles, the print profile and the owner', async () => {
    expect(
      await q('SELECT code, is_default FROM erp.price_tiers WHERE tenant_id = :tenant ORDER BY sort'),
    ).toEqual([
      { code: 'RETAIL', is_default: true },
      { code: 'MECHANIC', is_default: false },
      { code: 'WHOLESALE', is_default: false },
    ]);
    expect(await q('SELECT code, rate_bp, is_default FROM erp.tax_codes WHERE tenant_id = :tenant')).toEqual([
      { code: 'ZERO', rate_bp: 0, is_default: true },
    ]);
    expect(
      (
        await q<{ template_key: string }>(
          'SELECT template_key FROM erp.roles WHERE tenant_id = :tenant ORDER BY 1',
        )
      ).map((r) => r.template_key),
    ).toEqual(['accountant', 'cashier', 'manager', 'owner', 'purchaser', 'salesman']);
    expect(
      await q(
        'SELECT paper_format, code_type, copies, is_tenant_default FROM erp.print_profiles WHERE tenant_id = :tenant',
      ),
    ).toEqual([{ paper_format: 'a5', code_type: 'barcode', copies: 1, is_tenant_default: true }]);
    expect(
      await q(`SELECT u.username, u.password_hash, u.must_change_password, r.template_key FROM erp.users u
               JOIN erp.user_roles ur ON ur.user_id = u.id JOIN erp.roles r ON r.id = ur.role_id
               WHERE u.tenant_id = :tenant`),
    ).toEqual([
      {
        username: 'fahad',
        password_hash: 'argon2-hash-from-the-api',
        must_change_password: false,
        template_key: 'owner',
      },
    ]);
  });
});

describe('running it again', () => {
  it('changes nothing and says so', async () => {
    const before = await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM erp.audit_log WHERE tenant_id = :tenant',
    );
    const again = await setupTenant(db.ownerUrl, spec, {
      ownerPasswordHash: 'another-hash',
      mustChangePassword: true,
    });
    expect(again.tenantId).toBe(tenantId);
    expect(again.created).toEqual([]);
    expect(again.updated).toEqual([]);
    expect(again.drift).toEqual([]);
    const after = await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM erp.audit_log WHERE tenant_id = :tenant',
    );
    expect(after[0]!.n).toBe(before[0]!.n);
    // The existing owner keeps their password.
    expect(
      await q("SELECT password_hash FROM erp.users WHERE tenant_id = :tenant AND username = 'fahad'"),
    ).toEqual([{ password_hash: 'argon2-hash-from-the-api' }]);
  });

  it('reports a changed setting as drift and does not apply it', async () => {
    const changed = TenantSpec.parse({
      ...deluxSpec,
      closingTime: '21:00',
      branch: { ...deluxSpec.branch, name: 'Renamed' },
    });
    const report = await setupTenant(db.ownerUrl, changed, {
      ownerPasswordHash: 'x',
      mustChangePassword: true,
    });
    expect(report.created).toEqual([]);
    expect(report.drift).toEqual([
      'tenant closing_time: database 20:00, spec 21:00',
      'branch MAIN name: database "Delux Autos", spec "Renamed"',
    ]);
    expect(await q('SELECT closing_time FROM erp.tenants WHERE id = :tenant')).toEqual([
      { closing_time: '20:00:00' },
    ]);
  });
});

describe('moving a payment method to another bank (ACC-08, owner answer 1 to W1-08)', () => {
  const withRaast = (bankAccount: string | null) =>
    TenantSpec.parse({
      ...deluxSpec,
      paymentMethods: deluxSpec.paymentMethods.map((m) => (m.code === 'raast' ? { ...m, bankAccount } : m)),
    });
  const raastBank = async () =>
    (
      await q<{ bank: string | null }>(
        `SELECT b.code AS bank FROM erp.payment_methods pm LEFT JOIN erp.bank_accounts b ON b.id = pm.bank_account_id
         WHERE pm.tenant_id = :tenant AND pm.code = 'raast'`,
      )
    )[0]!.bank;
  const audits = () =>
    q<{ before: { bank_account_id: string | null }; after: { bank_account_id: string | null } }>(
      `SELECT before, after FROM erp.audit_log
       WHERE tenant_id = :tenant AND entity = 'payment_methods' AND action = 'update' ORDER BY at, id`,
    );

  it('applies the new bank from the spec, says so, and writes it to the audit log', async () => {
    const report = await setupTenant(db.ownerUrl, withRaast('soneri'), {
      ownerPasswordHash: 'x',
      mustChangePassword: true,
    });
    expect(report.updated).toEqual(['payment method raast bank account: hbl → soneri']);
    expect(report.drift).toEqual([]);
    expect(await raastBank()).toBe('soneri');
    expect(await audits()).toHaveLength(1);
  });

  it('changes nothing when the spec already says so', async () => {
    const report = await setupTenant(db.ownerUrl, withRaast('soneri'), {
      ownerPasswordHash: 'x',
      mustChangePassword: true,
    });
    expect(report.updated).toEqual([]);
    expect(await audits()).toHaveLength(1);
  });

  it('can take a method off its bank again, which then needs attention', async () => {
    const report = await setupTenant(db.ownerUrl, withRaast(null), {
      ownerPasswordHash: 'x',
      mustChangePassword: true,
    });
    expect(report.updated).toEqual(['payment method raast bank account: soneri → none']);
    expect(report.needsAttention).toEqual(['payment method raast has no account yet']);
    expect(await raastBank()).toBeNull();
  });

  it('puts it back on HBL', async () => {
    await setupTenant(db.ownerUrl, spec, { ownerPasswordHash: 'x', mustChangePassword: true });
    expect(await raastBank()).toBe('hbl');
  });
});

describe('the support password reset', () => {
  it('sets a temporary password that must be changed, unlocks the user and ends their sessions', async () => {
    await admin.query(
      `INSERT INTO erp.user_login_state (user_id, tenant_id, failed_logins, locked_until)
       SELECT id, tenant_id, 0, now() + interval '15 minutes' FROM erp.users WHERE tenant_id = $1`,
      [tenantId],
    );
    await admin.query(
      `INSERT INTO erp.sessions (tenant_id, user_id, token_hash, created_at, expires_at, last_seen_at)
       SELECT tenant_id, id, '\x01', now(), now() + interval '1 hour', now() FROM erp.users WHERE tenant_id = $1`,
      [tenantId],
    );
    await resetUserPassword(db.ownerUrl, 'delux', 'FAHAD', { passwordHash: 'temporary-hash' });
    expect(
      await q('SELECT password_hash, must_change_password FROM erp.users WHERE tenant_id = :tenant'),
    ).toEqual([{ password_hash: 'temporary-hash', must_change_password: true }]);
    expect(await q('SELECT locked_until FROM erp.user_login_state WHERE tenant_id = :tenant')).toEqual([
      { locked_until: null },
    ]);
    expect(
      await q('SELECT count(*)::int AS n FROM erp.sessions WHERE tenant_id = :tenant AND revoked_at IS NULL'),
    ).toEqual([{ n: 0 }]);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM erp.audit_log WHERE tenant_id = :tenant AND action = 'password.reset'",
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('refuses an unknown shop or user', async () => {
    await expect(resetUserPassword(db.ownerUrl, 'nope', 'fahad', { passwordHash: 'x' })).rejects.toThrow(
      'no shop nope',
    );
    await expect(resetUserPassword(db.ownerUrl, 'delux', 'nobody', { passwordHash: 'x' })).rejects.toThrow(
      'no user nobody in delux',
    );
  });
});
