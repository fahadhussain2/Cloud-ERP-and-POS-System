import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TenantSpec } from '@erp/contracts';
import { setupTenant } from '@erp/db';
import { createTestDatabase, type TestDatabase } from '@erp/db/testing';
import { validateChartOfAccounts } from '@erp/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import deluxSpec from '../../../infra/db/tenants/delux.json';
import mappingFile from '../golden/transform/mapping.json';
import { importMasters, type ImportResult } from './load';
import { writeImportReports } from './reports';
import { stageDump } from './stage';
import { parseMapping } from './transform/mapping';

// The masters import (W0-13, D-085) on a synthetic dump with the real column lists: no real data in git or CI.

let app: TestDatabase;
let admin: pg.Client;
let stagingDb: string;
let stagingUrl: string;
let dir: string;
let first: ImportResult;
const mapping = parseMapping(mappingFile);

const I = (table: string, columns: string[], rows: string[][]) =>
  rows.map(
    (r) => `INSERT [dbo].[${table}] (${columns.map((c) => `[${c}]`).join(', ')}) VALUES (${r.join(', ')})`,
  );
const s = (v: string) => `N'${v.replace(/'/g, "''")}'`;
const n = 'NULL';
const C = ['[CompanyID]', '[ChartOfAccountID]'].map((c) => c.slice(1, -1));
const co = ['1', '1'];

const ITEM_COLUMNS = [
  ...C,
  'ItemID',
  'Item',
  'CategoryID',
  'UnitID',
  'ManufactureID',
  'ManufactureCTID',
  'BrandID',
  'MakeID',
  'SizeID',
  'BPAccountCode',
  'DefaultSupplierCode',
  'Model',
  'PartNo',
  'PlaceofItem',
  'MinQuantity',
  'MaxQuantity',
  'CostPrice',
  'SalePrice',
  'OpeningQuantity',
  'OpeningRate',
  'IsExcludeOrderList',
  'ItemReferenceNo',
];
const item = (code: string, name: string, o: Record<string, string>) =>
  ITEM_COLUMNS.map((c) =>
    c === 'CompanyID' || c === 'ChartOfAccountID'
      ? '1'
      : c === 'ItemID'
        ? s(code)
        : c === 'Item'
          ? s(name)
          : (o[c] ?? n),
  );
const dec = (v: string) => `CAST(${v} AS Decimal(18, 2))`;

const files = (items: string[][]): Record<string, string[]> => ({
  'dbo.INV_Unit.Table.sql': I(
    'INV_Unit',
    [...C, 'UnitID', 'Unit'],
    [
      [...co, '1', s('PCS')],
      [...co, '2', s('LITRE')],
    ],
  ),
  'dbo.INV_Category.Table.sql': I(
    'INV_Category',
    [...C, 'CategoryID', 'Category'],
    [
      [...co, s('ABEA'), s('ENGINE')],
      [...co, s('BBCD'), s('BRAKES')],
    ],
  ),
  'dbo.INV_Brand.Table.sql': I(
    'INV_Brand',
    [...C, 'BrandID', 'Brand'],
    [
      [...co, '1', s('GENUINE')],
      [...co, '2', s('CHINA')],
      [...co, '3', s('NGK')],
    ],
  ),
  'dbo.INV_Make.Table.sql': I(
    'INV_Make',
    [...C, 'MakeID', 'Make'],
    [
      [...co, '1', s('JAPAN')],
      [...co, '2', s('INDONASIA')],
    ],
  ),
  'dbo.INV_Manufacture.Table.sql': I(
    'INV_Manufacture',
    [...C, 'ManufactureID', 'Manufacture'],
    [
      [...co, '1', s('TOYOTA')],
      [...co, '2', s('H4')],
      [...co, '3', s('UNIVERSAL')],
      [...co, '4', s('HIACE')],
    ],
  ),
  'dbo.INV_ManufactureCT.Table.sql': I(
    'INV_ManufactureCT',
    [...C, 'ManufactureCTID', 'ManufactureCT', 'ManufactureID'],
    [[...co, '1', s('TOYOTA'), '1']],
  ),
  'dbo.INV_Size.Table.sql': I(
    'INV_Size',
    [...C, 'SizeID', 'Size'],
    [
      [...co, '1', s('None')],
      [...co, '2', s('FRONT')],
    ],
  ),
  'dbo.INV_Item.Table.sql': I('INV_Item', ITEM_COLUMNS, items),
  'dbo.Admin_Country.Table.sql': I('Admin_Country', ['CountryID', 'Country'], [['1', s('Pakistan')]]),
  'dbo.Admin_City.Table.sql': I('Admin_City', ['CityID', 'City', 'CountryID'], [['1', s('Karachi'), '1']]),
  'dbo.INV_BusinessPartnerType.Table.sql': I(
    'INV_BusinessPartnerType',
    ['BusinessPartnerTypeID', 'BusinessPartnerType', 'Status', 'Purchase', 'Sale'],
    [
      ['1', s('Supplier'), '1', '1', '0'],
      ['2', s('Customer'), '1', '0', '1'],
    ],
  ),
  'dbo.INV_BusinessPartner.Table.sql': I(
    'INV_BusinessPartner',
    [
      ...C,
      'BusinessPartnerID',
      'BusinessPartner',
      'ContactPerson',
      'CountryID',
      'CityID',
      'BPAddress1',
      'BPAddress2',
      'BPPhone1',
      'BPPhone2',
      'BPFax1',
      'BPFax2',
      'BPMobile1',
      'BPMobile2',
      'BPEmail1',
      'BPEmail2',
      'BPNTN',
      'BPNameAbbr',
    ],
    [
      [...co, s('0001'), s('CASH PURCHASE'), n, n, n, n, n, n, n, n, n, n, n, n, n, n, n],
      [...co, s('0002'), s('CASH SALE'), n, n, n, n, n, n, n, n, n, n, n, n, n, n, n],
      [
        ...co,
        s('0101'),
        s('ADDI AUTOS'),
        s('Asif'),
        '1',
        '1',
        s('Plaza 4'),
        s('Shop 12'),
        s('021-34567890'),
        s(''),
        s('021-111'),
        n,
        s('0300-1234567'),
        s('03001234567'),
        s('addi@example.test'),
        n,
        s('1234567-8'),
        s('ADDI'),
      ],
      [...co, s('0150'), s('KHAN MECHANIC'), n, '1', '1', n, n, n, n, n, n, s('0333-7654321'), n, n, n, n, n],
      [...co, s('0200'), s('BOTH  TRADERS'), n, n, n, n, n, n, n, n, n, n, n, n, n, n, s('ADDI')],
    ],
  ),
  'dbo.INV_BusinessPartnerSelection.Table.sql': I(
    'INV_BusinessPartnerSelection',
    [...C, 'AccountCode', 'BusinessPartnerID', 'BusinessPartnerTypeID'],
    [
      [...co, s('20-03-0001'), s('0001'), '1'],
      [...co, s('10-02-0001'), s('0002'), '2'],
      [...co, s('20-02-0001'), s('0101'), '1'],
      [...co, s('10-03-0001'), s('0150'), '2'],
      [...co, s('20-02-0001'), s('0200'), '1'],
      [...co, s('10-03-0001'), s('0200'), '2'],
    ],
  ),
  'dbo.GL_ChartofAccount.Table.sql': I(
    'GL_ChartofAccount',
    [...C, 'AccountCode', 'Description', 'AccountTypeID', 'HeadAccountCode', 'SummaryFlag'],
    [
      [...co, s('10'), s('ASSETS'), '1', n, '1'],
      [...co, s('10-01-0001'), s('CASH IN HAND'), '1', s('10-01'), '0'],
      [...co, s('10-01-0002'), s('CHEQUE IN HAND'), '1', s('10-01'), '0'],
      [...co, s('10-04-0002'), s('HBL'), '1', s('10-04'), '0'],
      [...co, s('20-01-0001'), s('PURCHASES'), '2', s('20-01'), '0'],
      [...co, s('40-03'), s('UTILITIES'), '5', s('40'), '1'],
      [...co, s('40-03-0001'), s('ELECTRICITY  BILL'), '5', s('40-03'), '0'],
      [...co, s('40-03-0002'), s('GAS BILL'), '5', s('40-03'), '0'],
      [...co, s('40-05-0001'), s('PARTNER A EXP'), '5', s('40-05'), '0'],
      [...co, s('60-01-0001'), s('SOMETHING NEW'), '5', s('60-01'), '0'],
    ],
  ),
  'dbo.GL_TransactionDetail.Table.sql': I(
    'GL_TransactionDetail',
    [
      'CompanyID',
      'PeriodID',
      'TransactionID',
      'SerialNo',
      'ChartOfAccountID',
      'AccountCode',
      'SubAccountCode',
      'CostCenterID',
      'CurrencyID',
      'ConversionRate',
      'AmountFC',
      'AmountDR',
      'AmountCR',
    ],
    [
      [
        '1',
        '1',
        '1',
        '1',
        '1',
        s('10-03-0001'),
        s('0150'),
        '1',
        '1',
        '1',
        dec('0'),
        dec('5000.00'),
        dec('0.00'),
      ],
      [
        '1',
        '1',
        '2',
        '1',
        '1',
        s('10-03-0001'),
        s('0150'),
        '1',
        '1',
        '1',
        dec('0'),
        dec('0.00'),
        dec('1500.00'),
      ],
    ],
  ),
});

const ITEMS = [
  item('ABEA001', 'OIL FILTER (04465-0K240)', {
    CategoryID: s('ABEA'),
    UnitID: '1',
    ManufactureID: '1',
    BrandID: '1',
    MakeID: '1',
    SizeID: '1',
    Model: s('2012-ON'),
    PartNo: s('17910-SO4-E84'),
    PlaceofItem: s('A-12'),
    MinQuantity: dec('2'),
    MaxQuantity: dec('10'),
    CostPrice: dec('900.00'),
    SalePrice: dec('1250.00'),
    IsExcludeOrderList: 'CAST(0 AS bit)',
    ItemReferenceNo: s('ALT-1'),
    DefaultSupplierCode: s('0101'),
  }),
  item('ABEA002', 'BRAKE PAD', {
    CategoryID: s('ABEA'),
    UnitID: '1',
    ManufactureID: '2',
    BrandID: '2',
    SizeID: '2',
    Model: s('MEHRAN'),
    PartNo: s('WHITE'),
    PlaceofItem: s('0'),
    CostPrice: dec('0.00'),
    SalePrice: dec('0.00'),
    IsExcludeOrderList: 'CAST(1 AS bit)',
  }),
  item('BBCD001', 'OIL  FILTER', {
    CategoryID: s('BBCD'),
    UnitID: '2',
    ManufactureID: '3',
    BrandID: '3',
    MakeID: '2',
    Model: s(''),
    PartNo: s('04465-0K240'),
    MinQuantity: dec('1.5'),
    CostPrice: dec('500.00'),
    SalePrice: dec('450.00'),
    DefaultSupplierCode: s('0999'),
  }),
  item('BBCD002', 'FREE', {
    CategoryID: s('BBCD'),
    UnitID: '1',
    ManufactureID: '4',
    Model: s('2003-2008'),
    SalePrice: dec('10.00'),
  }),
  item('BBCD003', 'FREE', {
    CategoryID: s('BBCD'),
    UnitID: '1',
    SalePrice: dec('11.00'),
    CostPrice: dec('5.00'),
  }),
];

const stage = async (label: string, items = ITEMS) => {
  const d = join(dir, label);
  await rm(d, { recursive: true, force: true });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(d, { recursive: true });
  for (const [file, lines] of Object.entries(files(items)))
    await writeFile(
      join(d, file),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]),
    );
  await stageDump({ url: stagingUrl, label, dumpDir: d });
};

const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await admin.query<T>(sql.replaceAll(':tenant', `'${first.tenantId}'`), params)).rows;

const run = (over: Partial<Parameters<typeof importMasters>[0]> = {}) =>
  importMasters({ stagingUrl, label: 'fixture', appUrl: app.appUrl, tenantCode: 'delux', mapping, ...over });

const nothingChanged = (r: ImportResult) =>
  Object.entries(r.groups).filter(([, g]) => g.created > 0 || g.updated > 0 || g.retired > 0);

beforeAll(async () => {
  app = await createTestDatabase();
  admin = new pg.Client({ connectionString: app.adminUrl });
  await admin.connect();
  await setupTenant(app.ownerUrl, TenantSpec.parse(deluxSpec), {
    ownerPasswordHash: 'x',
    mustChangePassword: true,
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
  dir = await mkdtemp(join(tmpdir(), 'legacy-load-'));
  await stage('fixture');
  first = await run();
});

afterAll(async () => {
  await admin?.end();
  await app?.drop();
  const c = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${stagingDb} WITH (FORCE)`);
  await c.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the first import', () => {
  it('loads every item with its code as the barcode, and the legacy keys', async () => {
    expect(first.groups.items).toMatchObject({ created: 5, updated: 0, unchanged: 0 });
    const items = await q<{ code: string; barcode: string; legacy: Record<string, unknown> }>(
      `SELECT i.code, b.value AS barcode, i.legacy FROM erp.items i
       JOIN erp.item_identifiers b ON b.item_id = i.id AND b.kind = 'barcode' WHERE i.tenant_id = :tenant ORDER BY i.code`,
    );
    expect(items.map((i) => [i.code, i.barcode])).toEqual([
      ['ABEA001', 'ABEA001'],
      ['ABEA002', 'ABEA002'],
      ['BBCD001', 'BBCD001'],
      ['BBCD002', 'BBCD002'],
      ['BBCD003', 'BBCD003'],
    ]);
    expect(items[0]!.legacy).toMatchObject({ label: 'fixture', ItemID: 'ABEA001', CostPrice: '900.00' });
  });

  it('maps brands, origins, makes, specs, variants and vehicle tags', async () => {
    const rows = await q(
      `SELECT i.code, i.name, b.name AS brand, o.name AS origin, i.spec, i.variant, i.bin_location, u.code AS unit,
              c.code AS category, i.min_qty::text, i.max_qty::text, i.exclude_from_reorder,
              s.code AS supplier, vm.name AS make, t.model, t.year_from, t.year_to
       FROM erp.items i
       LEFT JOIN erp.brands b ON b.id = i.brand_id LEFT JOIN erp.origins o ON o.id = i.origin_id
       JOIN erp.units u ON u.id = i.unit_id JOIN erp.categories c ON c.id = i.category_id
       LEFT JOIN erp.parties s ON s.id = i.default_supplier_id
       LEFT JOIN erp.item_compatibility t ON t.item_id = i.id AND t.deleted_at IS NULL
       LEFT JOIN erp.vehicle_makes vm ON vm.id = t.make_id
       WHERE i.tenant_id = :tenant ORDER BY i.code`,
    );
    expect(rows).toEqual([
      {
        code: 'ABEA001',
        name: 'OIL FILTER (04465-0K240)',
        brand: 'Genuine (OEM)',
        origin: 'Japan',
        spec: null,
        variant: null,
        bin_location: 'A-12',
        unit: 'PCS',
        category: 'ABEA',
        min_qty: '2.000',
        max_qty: '10.000',
        exclude_from_reorder: false,
        supplier: '0101',
        make: 'Toyota',
        model: null,
        year_from: 2012,
        year_to: null,
      },
      {
        code: 'ABEA002',
        name: 'BRAKE PAD',
        brand: null,
        origin: 'China',
        spec: 'H4, WHITE',
        variant: 'FRONT',
        bin_location: null,
        unit: 'PCS',
        category: 'ABEA',
        min_qty: null,
        max_qty: null,
        exclude_from_reorder: true,
        supplier: null,
        make: null,
        model: 'MEHRAN',
        year_from: null,
        year_to: null,
      },
      {
        code: 'BBCD001',
        name: 'OIL FILTER',
        brand: 'NGK',
        origin: 'Indonesia',
        spec: null,
        variant: null,
        bin_location: null,
        unit: 'LITRE',
        category: 'BBCD',
        min_qty: '1.500',
        max_qty: null,
        exclude_from_reorder: false,
        supplier: null,
        make: null,
        model: null,
        year_from: null,
        year_to: null,
      },
      {
        code: 'BBCD002',
        name: 'FREE',
        brand: null,
        origin: null,
        spec: null,
        variant: null,
        bin_location: null,
        unit: 'PCS',
        category: 'BBCD',
        min_qty: null,
        max_qty: null,
        exclude_from_reorder: false,
        supplier: null,
        make: 'Toyota',
        model: 'Hiace',
        year_from: 2003,
        year_to: 2008,
      },
      {
        code: 'BBCD003',
        name: 'FREE',
        brand: null,
        origin: null,
        spec: null,
        variant: null,
        bin_location: null,
        unit: 'PCS',
        category: 'BBCD',
        min_qty: null,
        max_qty: null,
        exclude_from_reorder: false,
        supplier: null,
        make: null,
        model: null,
        year_from: null,
        year_to: null,
      },
    ]);
  });

  it('adds OEM numbers from PartNo and from the name, and the alternate reference', async () => {
    expect(
      await q(
        `SELECT i.code, x.kind, x.value, x.normalized_value FROM erp.item_identifiers x JOIN erp.items i ON i.id = x.item_id
         WHERE x.tenant_id = :tenant AND x.kind <> 'barcode' AND x.deleted_at IS NULL ORDER BY i.code, x.kind, x.value`,
      ),
    ).toEqual([
      { code: 'ABEA001', kind: 'alternate', value: 'ALT-1', normalized_value: 'ALT1' },
      { code: 'ABEA001', kind: 'oem', value: '04465-0K240', normalized_value: '044650K240' },
      { code: 'ABEA001', kind: 'oem', value: '17910-SO4-E84', normalized_value: '17910SO4E84' },
      { code: 'BBCD001', kind: 'oem', value: '04465-0K240', normalized_value: '044650K240' },
    ]);
  });

  it('sets Retail from the legacy price and Mechanic and Wholesale from it', async () => {
    expect(
      await q(
        `SELECT t.code AS tier, p.price::int FROM erp.item_prices p JOIN erp.items i ON i.id = p.item_id
         JOIN erp.price_tiers t ON t.id = p.tier_id WHERE i.tenant_id = :tenant AND i.code = 'ABEA001' ORDER BY t.sort`,
      ),
    ).toEqual([
      { tier: 'RETAIL', price: 125000 },
      { tier: 'MECHANIC', price: 118800 },
      { tier: 'WHOLESALE', price: 112500 },
    ]);
  });

  it('creates the categories with the accepted pricing and return rules, and the units', async () => {
    expect(
      await q(
        'SELECT code, name, pricing_rule, return_policy FROM erp.categories WHERE tenant_id = :tenant ORDER BY code',
      ),
    ).toEqual([
      {
        code: 'ABEA',
        name: 'ENGINE',
        pricing_rule: { floor_min_margin_bp: 500 },
        return_policy: { returnable: true, window_days: 30 },
      },
      {
        code: 'BBCD',
        name: 'BRAKES',
        pricing_rule: { floor_min_margin_bp: 500 },
        return_policy: { returnable: true, window_days: 30 },
      },
    ]);
    expect(
      await q('SELECT code, allows_fraction FROM erp.units WHERE tenant_id = :tenant ORDER BY code'),
    ).toEqual([
      { code: 'LITRE', allows_fraction: true },
      { code: 'PCS', allows_fraction: false },
    ]);
  });

  it('loads the parties (not the cash partners) with their roles, contacts and terms', async () => {
    expect(
      await q(
        `SELECT p.code, p.name, p.contact_person, p.phones, p.email, p.address, p.city, p.country, p.tax_id, p.label_abbr,
                t.code AS tier, ca.credit_allowed, ca.credit_limit, ca.offline_daily_cap::int, (sa.id IS NOT NULL) AS supplier
         FROM erp.parties p LEFT JOIN erp.customer_accounts ca ON ca.party_id = p.id
         LEFT JOIN erp.price_tiers t ON t.id = ca.price_tier_id LEFT JOIN erp.supplier_accounts sa ON sa.party_id = p.id
         WHERE p.tenant_id = :tenant ORDER BY p.code`,
      ),
    ).toEqual([
      {
        code: '0101',
        name: 'ADDI AUTOS',
        contact_person: 'Asif',
        phones: ['021-34567890', '0300-1234567'],
        email: 'addi@example.test',
        address: 'Plaza 4, Shop 12',
        city: 'Karachi',
        country: 'Pakistan',
        tax_id: '1234567-8',
        label_abbr: 'ADDI',
        tier: null,
        credit_allowed: null,
        credit_limit: null,
        offline_daily_cap: null,
        supplier: true,
      },
      {
        code: '0150',
        name: 'KHAN MECHANIC',
        contact_person: null,
        phones: ['0333-7654321'],
        email: null,
        address: null,
        city: 'Karachi',
        country: 'Pakistan',
        tax_id: null,
        label_abbr: null,
        tier: 'MECHANIC',
        credit_allowed: true,
        credit_limit: null,
        offline_daily_cap: 2500000,
        supplier: false,
      },
      {
        code: '0200',
        name: 'BOTH TRADERS',
        contact_person: null,
        phones: [],
        email: null,
        address: null,
        city: null,
        country: null,
        tax_id: null,
        label_abbr: 'ADDI',
        tier: 'RETAIL',
        credit_allowed: true,
        credit_limit: null,
        offline_daily_cap: 2500000,
        supplier: true,
      },
    ]);
  });

  it('maps the legacy chart into the template, adds the expense accounts, and the chart stays valid', async () => {
    const accounts = await q<{
      code: string;
      name: string;
      type: string;
      parent_code: string | null;
      is_postable: boolean;
      system_role: string | null;
      legacy_code: string | null;
    }>(
      `SELECT a.code, a.name, a.type, p.code AS parent_code, a.is_postable, a.system_role, a.legacy_code
       FROM erp.accounts a LEFT JOIN erp.accounts p ON p.id = a.parent_id WHERE a.tenant_id = :tenant ORDER BY a.code`,
    );
    const byLegacy = Object.fromEntries(
      accounts
        .filter((a) => a.legacy_code)
        .map((a): [string, string[]] => [a.legacy_code!, [a.code, a.name]]),
    );
    expect(byLegacy).toEqual({
      '10-01-0001': ['1110', 'Cash drawer (cash desk)'],
      '10-04-0002': ['1160', 'Bank: HBL'],
      '40-03-0001': ['6211', 'ELECTRICITY BILL'],
      '40-03-0002': ['6212', 'GAS BILL'],
    });
    expect(accounts.find((a) => a.code === '6211')).toMatchObject({
      type: 'expense',
      parent_code: '6200',
      is_postable: true,
    });
    expect(
      validateChartOfAccounts(
        accounts.map((a) => ({
          code: a.code,
          type: a.type,
          parentCode: a.parent_code,
          isPostable: a.is_postable,
          systemRole: a.system_role,
        })),
      ),
    ).toEqual([]);
    expect(
      await q(
        `SELECT e.code, e.name, a.code AS account FROM erp.expense_categories e JOIN erp.accounts a ON a.id = e.gl_account_id
         WHERE e.tenant_id = :tenant AND e.code LIKE '40-%' ORDER BY e.code`,
      ),
    ).toEqual([
      { code: '40-03-0001', name: 'ELECTRICITY BILL', account: '6211' },
      { code: '40-03-0002', name: 'GAS BILL', account: '6212' },
    ]);
  });

  it('reports what needs a decision', () => {
    const f = first.findings;
    expect(f.brandCountries).toEqual([{ brand: 'CHINA', origin: 'China', items: 1 }]);
    expect(f.partNoNotOem).toEqual([{ item: 'ABEA002', partNo: 'WHITE' }]);
    expect(f.manufactureSpec).toEqual([{ value: 'H4', items: 1 }]);
    expect(f.modelText).toEqual([{ value: 'MEHRAN', items: 1 }]);
    expect(f.priceZero).toEqual([{ item: 'ABEA002', name: 'BRAKE PAD' }]);
    expect(f.costAbovePrice).toEqual([{ item: 'BBCD001', name: 'OIL FILTER', cost: 50000, price: 45000 }]);
    expect(f.noCost.map((x) => x.item)).toEqual(['ABEA002', 'BBCD002']);
    expect(f.duplicateNames).toEqual([{ name: 'FREE', items: ['BBCD002', 'BBCD003'] }]);
    expect(f.duplicateOem).toEqual([{ oem: '044650K240', items: ['ABEA001', 'BBCD001'] }]);
    expect(f.unknownReferences).toEqual([{ item: 'BBCD001', field: 'DefaultSupplierCode', value: '0999' }]);
    expect(f.accounts.unmapped).toEqual([{ legacyCode: '60-01-0001', name: 'SOMETHING NEW' }]);
    expect(f.accounts.drawings).toEqual([{ legacyCode: '40-05-0001', name: 'PARTNER A EXP', code: '3110' }]);
    expect(f.parties.noPhone.map((p) => p.code)).toEqual(['0200']);
    expect(f.parties.bothRoles.map((p) => p.code)).toEqual(['0200']);
    expect(f.parties.abbreviationClashes).toEqual([{ abbr: 'ADDI', parties: ['0101', '0200'] }]);
    expect(f.parties.creditCustomers).toEqual([
      {
        code: '0150',
        name: 'KHAN MECHANIC',
        tier: 'MECHANIC',
        creditAllowed: true,
        creditLimit: null,
        offlineDailyCap: 2500000,
        legacyBalance: 350000,
      },
      {
        code: '0200',
        name: 'BOTH TRADERS',
        tier: 'RETAIL',
        creditAllowed: true,
        creditLimit: null,
        offlineDailyCap: 2500000,
        legacyBalance: 0,
      },
    ]);
  });
});

describe('running it again', () => {
  it('changes nothing', async () => {
    const before = await q<{ n: number }>(
      'SELECT count(*)::int AS n FROM erp.audit_log WHERE tenant_id = :tenant',
    );
    const again = await run();
    expect(nothingChanged(again)).toEqual([]);
    expect(again.groups.items).toMatchObject({ created: 0, updated: 0, unchanged: 5 });
    expect(await q('SELECT count(*)::int AS n FROM erp.audit_log WHERE tenant_id = :tenant')).toEqual(before);
  });

  it('a dry run writes nothing', async () => {
    const changed = parseMapping({
      ...mappingFile,
      countryBrands: { ...mappingFile.countryBrands, NGK: 'Japan' },
    });
    const dry = await run({ mapping: changed, dryRun: true });
    expect(dry.groups.items.updated).toBe(1);
    expect(
      await q(
        "SELECT b.name FROM erp.items i JOIN erp.brands b ON b.id = i.brand_id WHERE i.tenant_id = :tenant AND i.code = 'BBCD001'",
      ),
    ).toEqual([{ name: 'NGK' }]);
  });

  it('a changed decision updates only the affected rows', async () => {
    const changed = parseMapping({
      ...mappingFile,
      countryBrands: { ...mappingFile.countryBrands, NGK: 'Japan' },
      partyTiers: { '0150': 'MECHANIC', '0200': 'WHOLESALE' },
    });
    const r = await run({ mapping: changed });
    expect(r.groups.items).toMatchObject({ created: 0, updated: 1, unchanged: 4 });
    expect(r.groups.customerAccounts).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(
      await q(
        "SELECT b.name AS brand, o.name AS origin FROM erp.items i LEFT JOIN erp.brands b ON b.id = i.brand_id LEFT JOIN erp.origins o ON o.id = i.origin_id WHERE i.tenant_id = :tenant AND i.code = 'BBCD001'",
      ),
    ).toEqual([{ brand: null, origin: 'Indonesia' }]);
  });

  it('credit terms from the mapping update the accounts; without an entry a customer gets the defaults (W1-09)', async () => {
    const terms = `SELECT p.code, ca.credit_allowed, ca.credit_limit::int, ca.offline_daily_cap::int
                   FROM erp.parties p JOIN erp.customer_accounts ca ON ca.party_id = p.id
                   WHERE p.tenant_id = :tenant ORDER BY p.code`;
    const withTerms = parseMapping({
      ...mappingFile,
      partyCredit: { '0150': { creditLimit: 50000, offlineDailyCap: 0 }, '0200': { creditAllowed: false } },
    });
    const r = await run({ mapping: withTerms });
    expect(r.groups.customerAccounts).toMatchObject({ created: 0, updated: 2 });
    expect(await q(terms)).toEqual([
      { code: '0150', credit_allowed: true, credit_limit: 5000000, offline_daily_cap: 0 },
      { code: '0200', credit_allowed: false, credit_limit: null, offline_daily_cap: 2500000 },
    ]);
    expect(r.findings.parties.creditCustomers.map((c) => [c.code, c.creditLimit, c.offlineDailyCap])).toEqual(
      [
        ['0150', 5000000, 0],
        ['0200', null, 2500000],
      ],
    );
    await run();
    expect(await q(terms)).toEqual([
      { code: '0150', credit_allowed: true, credit_limit: null, offline_daily_cap: 2500000 },
      { code: '0200', credit_allowed: true, credit_limit: null, offline_daily_cap: 2500000 },
    ]);
  });

  it('a PartNo that is no longer a part number retires its identifier, and a missing item is reported, not deleted', async () => {
    const items = ITEMS.filter((i) => i[2] !== s('BBCD003')).map((i) =>
      i[2] === s('ABEA001') ? i.map((v) => (v === s('17910-SO4-E84') ? s('GREEN') : v)) : i,
    );
    await stage('fixture', items);
    const r = await run();
    expect(r.groups.identifiers.retired).toBe(1);
    expect(r.findings.missing).toEqual([{ what: 'item', code: 'BBCD003' }]);
    expect(await q("SELECT status FROM erp.items WHERE tenant_id = :tenant AND code = 'BBCD003'")).toEqual([
      { status: 'active' },
    ]);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM erp.item_identifiers WHERE tenant_id = :tenant AND value = '17910-SO4-E84' AND deleted_at IS NULL",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('refuses a shop that does not exist', async () => {
    await expect(run({ tenantCode: 'nope' })).rejects.toThrow('no shop nope');
  });
});

describe('the reports', () => {
  it('writes the summary, the catalog and the party reports, with every phone masked', async () => {
    const out = await mkdtemp(join(tmpdir(), 'legacy-reports-'));
    try {
      await writeImportReports(first, join(out, 'fixture'));
      const names = (await readdir(join(out, 'fixture', 'reports'), { recursive: true }))
        .map((f) => f.replace(/\\/g, '/'))
        .sort();
      expect(names).toEqual(
        expect.arrayContaining([
          'index.html',
          'summary.json',
          'catalog/brand-countries.csv',
          'catalog/partno-not-oem.csv',
          'parties/credit-customers.csv',
          'company.md',
          'parties/no-phone.csv',
          'accounts/mapping.csv',
        ]),
      );
      const summary = JSON.parse(
        await readFile(join(out, 'fixture', 'reports', 'summary.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(JSON.stringify(summary)).not.toMatch(/KHAN|ADDI AUTOS/);
      for (const name of names.filter((f) => /\.(csv|html|json)$/.test(f))) {
        const text = await readFile(join(out, 'fixture', 'reports', name), 'utf8');
        for (const phone of ['1234567', '7654321', '34567890']) expect(text, name).not.toContain(phone);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
