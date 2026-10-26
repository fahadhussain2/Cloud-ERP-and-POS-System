import { z } from 'zod';

// Counter sync contracts (sync spec v1, W1-02, W1-03, D-089). Shared by the API and the POS.

/** How a pulled column is stored on the counter: money is whole minor units (CLAUDE.md rule 1). */
export type ColumnType = 'text' | 'int' | 'bool' | 'json' | 'money';

/**
 * The catalog datasets and the only columns each may send (sync spec §3, W1-03). A column not listed never leaves
 * the server: `legacy`, suppliers, reorder settings and audit columns stay there.
 */
export const CATALOG_COLUMNS = {
  price_tiers: { id: 'text', code: 'text', name: 'text', sort: 'int', is_default: 'bool' },
  units: { id: 'text', code: 'text', name: 'text', allows_fraction: 'bool' },
  categories: {
    id: 'text',
    code: 'text',
    name: 'text',
    parent_id: 'text',
    pricing_rule: 'json',
    return_policy: 'json',
  },
  brands: { id: 'text', name: 'text' },
  origins: { id: 'text', name: 'text' },
  vehicle_makes: { id: 'text', name: 'text' },
  items: {
    id: 'text',
    code: 'text',
    name: 'text',
    category_id: 'text',
    brand_id: 'text',
    origin_id: 'text',
    unit_id: 'text',
    variant: 'text',
    spec: 'text',
    bin_location: 'text',
    floor_price: 'money',
    tax_code_id: 'text',
    status: 'text',
  },
  item_identifiers: {
    id: 'text',
    item_id: 'text',
    kind: 'text',
    value: 'text',
    normalized_value: 'text',
    is_primary: 'bool',
  },
  item_compatibility: {
    id: 'text',
    item_id: 'text',
    make_id: 'text',
    model: 'text',
    year_from: 'int',
    year_to: 'int',
    note: 'text',
  },
  item_prices: { id: 'text', item_id: 'text', tier_id: 'text', price: 'money' },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type CatalogDataset = keyof typeof CATALOG_COLUMNS;
/** In pull order: lookups before the items that point at them. */
export const CATALOG_DATASETS = Object.keys(CATALOG_COLUMNS) as CatalogDataset[];

export const PULL_DATASETS = [
  'tenant',
  'branch',
  'users',
  'roles',
  'user_roles',
  ...(Object.keys(CATALOG_COLUMNS) as CatalogDataset[]),
] as const;
export type PullDataset = 'tenant' | 'branch' | 'users' | 'roles' | 'user_roles' | CatalogDataset;

export const PULL_LIMIT_DEFAULT = 500;
export const PULL_LIMIT_MAX = 1000;

export interface PullResponse {
  /** Changed rows per dataset, with only that dataset's listed columns. */
  changes: Partial<Record<PullDataset, Record<string, unknown>[]>>;
  /** Opaque: store it and send it back unchanged. */
  cursor: string;
  hasMore: boolean;
}

/** A manager gives someone a temporary PIN in the back office. */
export const TemporaryPinRequest = z.object({ pin: z.string().min(1).max(12) });

/** A counter replaces a temporary PIN with the person's own (sync spec §5). */
export const CounterPinChangeRequest = z.object({
  userId: z.uuid(),
  currentPin: z.string().min(1).max(12),
  newPin: z.string().min(1).max(12),
});
export type CounterPinChangeRequest = z.infer<typeof CounterPinChangeRequest>;
