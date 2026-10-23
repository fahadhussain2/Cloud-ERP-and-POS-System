import { TenantSpec } from '@erp/contracts';
import { REQUIRED_SYSTEM_ROLES } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../../infra/db/tenants/delux.json';
import { createTestDatabase, type TestDatabase } from '../testing/database';
import { setupTenant, type SetupReport } from './tenant';

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

  it('creates the branch with Shop, Godown and Damaged', async () => {
    const rows = await q<{ code: string; kind: string; is_sellable: boolean }>(
      'SELECT code, kind, is_sellable FROM erp.locations WHERE tenant_id = :tenant ORDER BY code',
    );
    expect(rows).toEqual([
      { code: 'DAMAGED', kind: 'damaged', is_sellable: false },
      { code: 'GODOWN', kind: 'storage', is_sellable: false },
      { code: 'SHOP', kind: 'shop', is_sellable: true },
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
      { code: 'bank_transfer', bank: null, requires_reference: true, is_cash: false },
      { code: 'card', bank: 'card', requires_reference: true, is_cash: false },
      { code: 'cash', bank: null, requires_reference: false, is_cash: true },
      { code: 'easypaisa', bank: 'easypaisa', requires_reference: true, is_cash: false },
      { code: 'jazzcash', bank: 'jazzcash', requires_reference: true, is_cash: false },
      { code: 'on_account', bank: null, requires_reference: false, is_cash: false },
      { code: 'raast', bank: null, requires_reference: true, is_cash: false },
    ]);
  });

  it('reports Raast and bank transfer as needing an account', () => {
    expect(first.needsAttention).toEqual([
      'payment method bank_transfer has no account yet',
      'payment method raast has no account yet',
    ]);
  });

  it('creates the tiers (Retail by default), the 0% tax code, the roles, the print profile and the owner', async () => {
    expect(
      await q('SELECT code, is_default FROM erp.price_tiers WHERE tenant_id = :tenant ORDER BY sort'),
    ).toEqual([
      { code: 'RETAIL', is_default: true },
      { code: 'MECHANIC', is_default: false },
      { code: 'WHOLESALE', is_default: false },
    ]);
    expect(await q('SELECT code, rate_bp FROM erp.tax_codes WHERE tenant_id = :tenant')).toEqual([
      { code: 'ZERO', rate_bp: 0 },
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
