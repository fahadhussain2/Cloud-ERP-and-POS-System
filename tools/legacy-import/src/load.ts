import { withTenant } from '@erp/db';
import pg from 'pg';

import { maskPhone } from './transform/rules';
import { companyDetails } from './transform/company';
import { buildMasters, type Findings, type Masters, type Row, type Staged } from './transform/masters';
import type { Mapping } from './transform/mapping';

// Loads the legacy masters into a tenant (W0-13, D-085): upsert by legacy key, only the differences, as the app
// role inside withTenant (RLS on), one transaction per entity group. A dry run does it all in one transaction
// and rolls it back.

export interface ImportOptions {
  /** The staging database (erp_legacy). */
  stagingUrl: string;
  label: string;
  /** The app database, as the app role (erp_app). */
  appUrl: string;
  tenantCode: string;
  mapping: Mapping;
  dryRun?: boolean;
}

export interface GroupCount {
  created: number;
  updated: number;
  unchanged: number;
  /** Imported child rows no longer derived from the dump (soft-deleted). */
  retired: number;
}

export const GROUPS = [
  'units',
  'categories',
  'brands',
  'origins',
  'vehicleMakes',
  'parties',
  'customerAccounts',
  'supplierAccounts',
  'items',
  'identifiers',
  'vehicleTags',
  'prices',
  'accounts',
  'expenseCategories',
] as const;
export type Group = (typeof GROUPS)[number];

export interface ImportResult {
  tenantId: string;
  label: string;
  dryRun: boolean;
  groups: Record<Group, GroupCount>;
  findings: Findings;
  /** Masked phones per party code, for the party reports (D-085). */
  partyPhones: Record<string, string[]>;
  /** Staged tables the import doesn't read. */
  unusedTables: string[];
  /** The shop's own details, for the bill header (no customer data, no credentials). */
  company: { field: string; value: string }[];
}

/** Category defaults accepted in the PRD: floor = cost + 5% (Q2); returns within 30 days (Q3). */
const PRICING_RULE = { floor_min_margin_bp: 500 };
const RETURN_POLICY = { returnable: true, window_days: 30 };
/** Rs 25,000 a day while offline (PRD Q6, D-013). */
const OFFLINE_DAILY_CAP = 2_500_000;
/** The template's AR control account (posting rules §2). */
const AR_CONTROL = '1200';

const USED = {
  units: 'inv_unit',
  categories: 'inv_category',
  brands: 'inv_brand',
  makes: 'inv_make',
  manufactures: 'inv_manufacture',
  sizes: 'inv_size',
  items: 'inv_item',
  partners: 'inv_businesspartner',
  selections: 'inv_businesspartnerselection',
  partnerTypes: 'inv_businesspartnertype',
  cities: 'admin_city',
  countries: 'admin_country',
  accounts: 'gl_chartofaccount',
  company: 'admin_company',
  parameters: 'admin_parameter',
} as const;
/** Read for the AR balances in the credit-customer report. */
const GL_LINES = 'gl_transactiondetail';
/** Staging's own bookkeeping, and the GL lines read above for the AR balances. */
const READ_ELSEWHERE = new Set(['_files', GL_LINES]);

/** JSON with sorted keys, numbers and strings alike, so database and candidate values compare equal. */
const canonical = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null,
  );
};

async function readStaging(
  url: string,
  label: string,
  arCodes: string[],
): Promise<{ staged: Staged; unusedTables: string[] }> {
  const schema = `legacy_${label}`;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (
      await c.query<{ table_name: string }>(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1',
        [schema],
      )
    ).rows.map((r) => r.table_name);
    if (tables.length === 0) throw new Error(`nothing staged as ${label}: run the stage step first`);
    const present = new Set(tables);
    const read = async (table: string, required: boolean): Promise<Row[]> => {
      if (!present.has(table)) {
        if (required) throw new Error(`${schema}.${table} is missing from the staged dump`);
        return [];
      }
      return (await c.query<Row>(`SELECT * FROM "${schema}"."${table}" ORDER BY _file, _line`)).rows;
    };
    // One query at a time: a pg client runs queries in sequence anyway.
    const parts = {} as Record<keyof typeof USED, Row[]>;
    for (const [k, t] of Object.entries(USED) as [keyof typeof USED, string][])
      parts[k] = await read(t, k === 'items' || k === 'categories' || k === 'units');

    // Balances on the legacy AR control account(s).
    const arBalances = new Map<string, string>();
    if (present.has(GL_LINES) && arCodes.length > 0) {
      const r = await c.query<{ code: string; balance: string }>(
        `SELECT trim(subaccountcode) AS code, sum(amountdr::numeric - amountcr::numeric)::text AS balance
         FROM "${schema}"."${GL_LINES}" WHERE accountcode = ANY($1) AND subaccountcode IS NOT NULL GROUP BY 1`,
        [arCodes],
      );
      for (const row of r.rows) arBalances.set(row.code, row.balance);
    }
    const used = new Set<string>([...Object.values(USED), ...READ_ELSEWHERE]);
    return {
      staged: { label, ...parts, arBalances },
      unusedTables: tables.filter((t) => !used.has(t)),
    };
  } finally {
    await c.end();
  }
}

type Client = pg.PoolClient;
const zero = (): GroupCount => ({ created: 0, updated: 0, unchanged: 0, retired: 0 });

/**
 * Upserts `rows` into `table` by `keyOf`, comparing `columns` only: inserts what's missing, updates what
 * differs, leaves the rest untouched (no audit noise). Returns the ids by key.
 */
async function upsert<R extends Record<string, unknown>>(
  c: Client,
  tenantId: string,
  table: string,
  keyColumn: string,
  rows: { key: string; values: R }[],
  count: GroupCount,
): Promise<Map<string, string>> {
  const columns = rows.length > 0 ? Object.keys(rows[0]!.values) : [];
  const existing = new Map(
    (
      await c.query<Record<string, unknown> & { id: string; _key: string }>(
        `SELECT id, ${keyColumn} AS _key${columns.map((col) => `, ${col}`).join('')} FROM erp.${table}
         WHERE deleted_at IS NULL`,
      )
    ).rows.map((r) => [r._key, r]),
  );
  const ids = new Map([...existing].map(([k, r]) => [k, r.id]));
  for (const { key, values } of rows) {
    const old = existing.get(key);
    if (!old) {
      const cols = ['tenant_id', ...columns];
      const r = await c.query<{ id: string }>(
        `INSERT INTO erp.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        [tenantId, ...columns.map((col) => values[col])],
      );
      ids.set(key, r.rows[0]!.id);
      count.created += 1;
      continue;
    }
    const changed = columns.filter((col) => canonical(old[col]) !== canonical(values[col]));
    if (changed.length === 0) {
      count.unchanged += 1;
      continue;
    }
    await c.query(
      `UPDATE erp.${table} SET ${changed.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [old.id, ...changed.map((col) => values[col])],
    );
    count.updated += 1;
  }
  return ids;
}

/** Child rows derived from an item (identifiers, the vehicle tag): insert, update, and retire what's gone. */
async function syncChildren(
  c: Client,
  tenantId: string,
  table: 'item_identifiers' | 'item_compatibility',
  columns: string[],
  wanted: { itemId: string; key: string; values: Record<string, unknown> }[],
  itemIds: Set<string>,
  keyOf: (row: Record<string, unknown>) => string,
  count: GroupCount,
): Promise<void> {
  const existing = new Map<string, Record<string, unknown> & { id: string; item_id: string }>();
  for (const r of (
    await c.query<Record<string, unknown> & { id: string; item_id: string }>(
      `SELECT id, item_id, ${columns.join(', ')} FROM erp.${table} WHERE deleted_at IS NULL AND legacy IS NOT NULL`,
    )
  ).rows)
    existing.set(`${r.item_id}|${keyOf(r)}`, r);
  const seen = new Set<string>();
  for (const w of wanted) {
    const k = `${w.itemId}|${w.key}`;
    seen.add(k);
    const old = existing.get(k);
    const values = { item_id: w.itemId, ...w.values };
    if (!old) {
      const cols = ['tenant_id', ...Object.keys(values)];
      await c.query(
        `INSERT INTO erp.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        [tenantId, ...Object.values(values)],
      );
      count.created += 1;
      continue;
    }
    const changed = columns.filter(
      (col) => canonical(old[col]) !== canonical(values[col as keyof typeof values]),
    );
    if (changed.length === 0) count.unchanged += 1;
    else {
      await c.query(
        `UPDATE erp.${table} SET ${changed.map((col, i) => `${col} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [old.id, ...changed.map((col) => values[col as keyof typeof values])],
      );
      count.updated += 1;
    }
  }
  for (const [k, old] of existing) {
    if (seen.has(k) || !itemIds.has(old.item_id)) continue;
    await c.query(`UPDATE erp.${table} SET deleted_at = now() WHERE id = $1`, [old.id]);
    count.retired += 1;
  }
}

export async function importMasters(opts: ImportOptions): Promise<ImportResult> {
  // The legacy codes the mapping sends to the AR control account, for the credit-customer report.
  const arCodes = [...opts.mapping.accounts.template]
    .filter(([, code]) => code === AR_CONTROL)
    .map(([legacy]) => legacy);
  const { staged, unusedTables } = await readStaging(opts.stagingUrl, opts.label, arCodes);
  const masters = buildMasters(staged, opts.mapping);
  const pool = new pg.Pool({ connectionString: opts.appUrl, max: 2 });
  try {
    const dir = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
      [opts.tenantCode],
    );
    const tenantId = dir.rows[0]?.tenant_id;
    if (!tenantId) throw new Error(`no shop ${opts.tenantCode}`);
    const groups = Object.fromEntries(GROUPS.map((g) => [g, zero()])) as Record<Group, GroupCount>;
    const steps = loadSteps(masters, tenantId, groups);

    class DryRun extends Error {}
    if (opts.dryRun) {
      await withTenant(pool, { tenantId }, async (_db, c) => {
        for (const step of steps) await step(c);
        throw new DryRun();
      }).catch((err: unknown) => {
        if (!(err instanceof DryRun)) throw err;
      });
    } else {
      for (const step of steps) await withTenant(pool, { tenantId }, (_db, c) => step(c));
    }

    return {
      tenantId,
      label: opts.label,
      dryRun: opts.dryRun ?? false,
      groups,
      findings: masters.findings,
      partyPhones: Object.fromEntries(masters.parties.map((p) => [p.code, p.phones.map(maskPhone)])),
      unusedTables,
      company: companyDetails(staged.company, staged.parameters),
    };
  } finally {
    await pool.end();
  }
}

/** One function per entity group, in dependency order; each runs in its own transaction. */
function loadSteps(
  ms: Masters,
  tenantId: string,
  groups: Record<Group, GroupCount>,
): ((c: Client) => Promise<void>)[] {
  const ids = {
    units: new Map<string, string>(),
    categories: new Map<string, string>(),
    brands: new Map<string, string>(),
    origins: new Map<string, string>(),
    makes: new Map<string, string>(),
    parties: new Map<string, string>(),
    items: new Map<string, string>(),
    tiers: new Map<string, string>(),
  };
  const lower = (s: string) => s.toLowerCase();

  return [
    // Reference data.
    async (c) => {
      ids.units = await upsert(
        c,
        tenantId,
        'units',
        'code',
        ms.units.map((u) => ({
          key: u.code,
          values: { code: u.code, name: u.code, allows_fraction: u.allowsFraction, legacy: u.legacy },
        })),
        groups.units,
      );
      ids.categories = await upsert(
        c,
        tenantId,
        'categories',
        'code',
        ms.categories.map((k) => ({
          key: k.code,
          values: {
            code: k.code,
            name: k.name,
            pricing_rule: PRICING_RULE,
            return_policy: RETURN_POLICY,
            legacy: k.legacy,
          },
        })),
        groups.categories,
      );
      ids.brands = await upsert(
        c,
        tenantId,
        'brands',
        'lower(name)',
        ms.brands.map((b) => ({ key: lower(b.name), values: { name: b.name, legacy: b.legacy } })),
        groups.brands,
      );
      ids.origins = await upsert(
        c,
        tenantId,
        'origins',
        'lower(name)',
        ms.origins.map((o) => ({ key: lower(o.name), values: { name: o.name, legacy: o.legacy } })),
        groups.origins,
      );
      ids.makes = await upsert(
        c,
        tenantId,
        'vehicle_makes',
        'lower(name)',
        ms.makes.map((name) => ({
          key: lower(name),
          values: { name, legacy: { label: ms.items[0]?.legacy['label'] ?? null } },
        })),
        groups.vehicleMakes,
      );
    },

    // Parties and their accounts.
    async (c) => {
      const tiers = await c.query<{ id: string; code: string }>(
        'SELECT id, code FROM erp.price_tiers WHERE deleted_at IS NULL',
      );
      ids.tiers = new Map(tiers.rows.map((t) => [t.code, t.id]));
      ids.parties = await upsert(
        c,
        tenantId,
        'parties',
        'code',
        ms.parties.map((p) => ({
          key: p.code,
          values: {
            code: p.code,
            name: p.name,
            contact_person: p.contactPerson,
            phones: p.phones,
            email: p.email,
            address: p.address,
            city: p.city,
            country: p.country,
            tax_id: p.taxId,
            label_abbr: p.labelAbbr,
            legacy: p.legacy,
          },
        })),
        groups.parties,
      );
      const partyId = (code: string) => ids.parties.get(code)!;
      await upsert(
        c,
        tenantId,
        'customer_accounts',
        'party_id::text',
        ms.parties
          .filter((p) => p.customer)
          .map((p) => {
            const tier = ids.tiers.get(p.customer!.tier);
            if (!tier) throw new Error(`the tenant has no price tier ${p.customer!.tier}`);
            return {
              key: partyId(p.code),
              values: {
                party_id: partyId(p.code),
                price_tier_id: tier,
                credit_allowed: true,
                offline_daily_cap: OFFLINE_DAILY_CAP,
                legacy: { label: p.legacy['label'], BusinessPartnerID: p.code },
              },
            };
          }),
        groups.customerAccounts,
      );
      await upsert(
        c,
        tenantId,
        'supplier_accounts',
        'party_id::text',
        ms.parties
          .filter((p) => p.supplier)
          .map((p) => ({
            key: partyId(p.code),
            values: {
              party_id: partyId(p.code),
              legacy: { label: p.legacy['label'], BusinessPartnerID: p.code },
            },
          })),
        groups.supplierAccounts,
      );
      const imported = await c.query<{ code: string }>(
        "SELECT code FROM erp.parties WHERE legacy ? 'BusinessPartnerID' AND deleted_at IS NULL",
      );
      const now = new Set(ms.parties.map((p) => p.code));
      for (const r of imported.rows)
        if (!now.has(r.code)) ms.findings.missing.push({ what: 'party', code: r.code });
    },

    // Items.
    async (c) => {
      ids.items = await upsert(
        c,
        tenantId,
        'items',
        'code',
        ms.items.map((i) => ({
          key: i.code,
          values: {
            code: i.code,
            name: i.name,
            category_id: ids.categories.get(i.category)!,
            unit_id: ids.units.get(i.unit)!,
            brand_id: i.brand === null ? null : ids.brands.get(lower(i.brand))!,
            origin_id: i.origin === null ? null : ids.origins.get(lower(i.origin))!,
            variant: i.variant,
            spec: i.spec,
            bin_location: i.binLocation,
            default_supplier_id: i.defaultSupplier === null ? null : ids.parties.get(i.defaultSupplier)!,
            min_qty: i.minQty,
            max_qty: i.maxQty,
            exclude_from_reorder: i.excludeFromReorder,
            legacy: i.legacy,
          },
        })),
        groups.items,
      );
      const imported = await c.query<{ code: string }>(
        "SELECT code FROM erp.items WHERE legacy ? 'ItemID' AND deleted_at IS NULL",
      );
      const now = new Set(ms.items.map((i) => i.code));
      for (const r of imported.rows)
        if (!now.has(r.code)) ms.findings.missing.push({ what: 'item', code: r.code });
      ms.findings.missing.sort((a, b) => a.what.localeCompare(b.what) || a.code.localeCompare(b.code));
    },

    // What each item carries: identifiers, its vehicle tag, its tier prices.
    async (c) => {
      const label = { label: ms.items[0]?.legacy['label'] ?? null };
      const itemIds = new Set(ms.items.map((i) => ids.items.get(i.code)!));
      await syncChildren(
        c,
        tenantId,
        'item_identifiers',
        ['kind', 'value', 'normalized_value', 'is_primary', 'legacy'],
        ms.items.flatMap((i) =>
          i.identifiers.map((x) => ({
            itemId: ids.items.get(i.code)!,
            key: `${x.kind}|${x.normalized}`,
            values: {
              kind: x.kind,
              value: x.value,
              normalized_value: x.normalized,
              is_primary: x.kind === 'barcode',
              legacy: label,
            },
          })),
        ),
        itemIds,
        (r) => `${String(r['kind'])}|${String(r['normalized_value'])}`,
        groups.identifiers,
      );
      await syncChildren(
        c,
        tenantId,
        'item_compatibility',
        ['make_id', 'model', 'year_from', 'year_to', 'legacy'],
        ms.items
          .filter((i) => i.tag)
          .map((i) => ({
            itemId: ids.items.get(i.code)!,
            key: 'tag',
            values: {
              make_id: i.tag!.make === null ? null : ids.makes.get(lower(i.tag!.make))!,
              model: i.tag!.model,
              year_from: i.tag!.yearFrom,
              year_to: i.tag!.yearTo,
              legacy: label,
            },
          })),
        itemIds,
        () => 'tag',
        groups.vehicleTags,
      );
      await upsert(
        c,
        tenantId,
        'item_prices',
        "item_id::text || '|' || tier_id::text",
        ms.items.flatMap((i) =>
          (['RETAIL', 'MECHANIC', 'WHOLESALE'] as const).map((t) => {
            const tier = ids.tiers.get(t);
            if (!tier) throw new Error(`the tenant has no price tier ${t}`);
            const item = ids.items.get(i.code)!;
            return { key: `${item}|${tier}`, values: { item_id: item, tier_id: tier, price: i.prices[t] } };
          }),
        ),
        groups.prices,
      );
    },

    // The chart: legacy codes on template accounts, the legacy expense accounts and their expense categories.
    async (c) => {
      const all = await c.query<{
        id: string;
        code: string;
        legacy_code: string | null;
        name: string;
        parent_code: string | null;
      }>(
        `SELECT a.id, a.code, a.legacy_code, a.name, p.code AS parent_code
         FROM erp.accounts a LEFT JOIN erp.accounts p ON p.id = a.parent_id WHERE a.deleted_at IS NULL`,
      );
      const byCode = new Map(all.rows.map((a) => [a.code, a]));
      const byLegacy = new Map(all.rows.filter((a) => a.legacy_code).map((a) => [a.legacy_code!, a]));
      const expenseIds = new Map<string, { id: string; name: string }>();
      for (const a of ms.accounts) {
        const current = byLegacy.get(a.legacyCode);
        if (a.target.kind === 'template') {
          const target = byCode.get(a.target.code);
          if (!target) throw new Error(`the chart has no account ${a.target.code}`);
          if (target.legacy_code === a.legacyCode) groups.accounts.unchanged += 1;
          else {
            await c.query('UPDATE erp.accounts SET legacy_code = $1 WHERE id = $2', [
              a.legacyCode,
              target.id,
            ]);
            groups.accounts.updated += 1;
          }
          continue;
        }
        const parent = byCode.get(a.target.parent);
        if (!parent) throw new Error(`the chart has no account ${a.target.parent}`);
        if (current) {
          if (current.name === a.name) groups.accounts.unchanged += 1;
          else {
            await c.query('UPDATE erp.accounts SET name = $1 WHERE id = $2', [a.name, current.id]);
            groups.accounts.updated += 1;
          }
          expenseIds.set(a.legacyCode, { id: current.id, name: a.name });
          continue;
        }
        // Next free code under the header: 6211, 6212… after the template's own 6210 (parent + 11 to parent + 99).
        const base = Number(a.target.parent);
        let code = base + 11;
        while (byCode.has(String(code))) code += 1;
        if (code > base + 99) throw new Error(`no free account code under ${a.target.parent}`);
        const r = await c.query<{ id: string }>(
          `INSERT INTO erp.accounts (tenant_id, code, name, type, parent_id, is_postable, legacy_code)
           VALUES ($1, $2, $3, 'expense', $4, true, $5) RETURNING id`,
          [tenantId, String(code), a.name, parent.id, a.legacyCode],
        );
        byCode.set(String(code), {
          id: r.rows[0]!.id,
          code: String(code),
          legacy_code: a.legacyCode,
          name: a.name,
          parent_code: parent.code,
        });
        expenseIds.set(a.legacyCode, { id: r.rows[0]!.id, name: a.name });
        groups.accounts.created += 1;
      }
      await upsert(
        c,
        tenantId,
        'expense_categories',
        'code',
        [...expenseIds].map(([legacyCode, a]) => ({
          key: legacyCode,
          values: { code: legacyCode, name: a.name, gl_account_id: a.id },
        })),
        groups.expenseCategories,
      );
    },
  ];
}
