import { z } from 'zod';

// Counter sync contracts (sync spec v1, W1-02, W1-03, D-089). Shared by the API and the POS.

/**
 * How a pulled column is stored on the counter: money is whole minor units, a quantity whole thousandths (CLAUDE.md
 * rule 1).
 */
export type ColumnType = 'text' | 'int' | 'bool' | 'json' | 'money' | 'qty';

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
  /**
   * The floor from cost (W1-14, D-092): one row per item with a known cost, keyed by `item_id`. The counter's floor is
   * the item's `floor_price`, else this, else the list price. Never shown on the counter.
   */
  item_floors: { item_id: 'text', floor: 'money' },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type CatalogDataset = keyof typeof CATALOG_COLUMNS;
/** In pull order: lookups before the items that point at them. */
export const CATALOG_DATASETS = Object.keys(CATALOG_COLUMNS) as CatalogDataset[];

/**
 * What paying and printing need, and the only columns each may send (sync spec §3, W1-06). Never a payment method's
 * `bank_account_id` (posting only) or a device's `public_key`; `device` is only the calling device's own row.
 */
export const CHECKOUT_COLUMNS = {
  payment_methods: {
    id: 'text',
    code: 'text',
    name: 'text',
    is_cash: 'bool',
    requires_reference: 'bool',
    is_active: 'bool',
    sort: 'int',
  },
  print_profiles: {
    id: 'text',
    name: 'text',
    paper_format: 'text',
    code_type: 'text',
    copies: 'int',
    template_options: 'json',
    is_tenant_default: 'bool',
  },
  device: { id: 'text', code: 'text', print_profile_id: 'text', status: 'text' },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type CheckoutDataset = keyof typeof CHECKOUT_COLUMNS;
export const CHECKOUT_DATASETS = Object.keys(CHECKOUT_COLUMNS) as CheckoutDataset[];

/**
 * Customers on the counter and the only columns each may send (sync spec §3, W1-09, D-096). Names and phones are
 * personal data: addresses, emails, tax numbers, notes, payment terms and `legacy` stay on the server.
 * `customer_balances` has one row per customer, keyed by `party_id`.
 */
export const CUSTOMER_COLUMNS = {
  customers: { id: 'text', code: 'text', name: 'text', phones: 'json', city: 'text', status: 'text' },
  customer_accounts: {
    id: 'text',
    party_id: 'text',
    price_tier_id: 'text',
    credit_allowed: 'bool',
    credit_limit: 'money',
    offline_daily_cap: 'money',
  },
  customer_balances: { party_id: 'text', balance: 'money', updated_at: 'text' },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type CustomerDataset = keyof typeof CUSTOMER_COLUMNS;
export const CUSTOMER_DATASETS = Object.keys(CUSTOMER_COLUMNS) as CustomerDataset[];

/**
 * Pulled only by cash desks (sync spec §3): the live queue (CSH-02, W1-10), the branch's bills with cash to take in or
 * pay out, with no lines, customer or payload; and what cash-out names (CSH-06, W1-11): suppliers and their balances,
 * expense categories and bank accounts, never their GL accounts or a supplier's contact details.
 */
export const CASH_DESK_COLUMNS = {
  cash_queue: {
    id: 'text',
    number: 'text',
    device_id: 'text',
    salesperson_user_id: 'text',
    created_at_device: 'text',
    business_date: 'text',
    cash_due: 'money',
    cash_received: 'money',
    change_due: 'money',
    handover_status: 'text',
    status: 'text',
    // W1-23 (D-111): a return's original (guard 2), the bill's void, and the movement that gave its cash back.
    return_of_number: 'text',
    void_number: 'text',
    cash_given_back_number: 'text',
  },
  suppliers: { id: 'text', code: 'text', name: 'text', phones: 'json', city: 'text', status: 'text' },
  supplier_balances: { party_id: 'text', balance: 'money', updated_at: 'text' },
  expense_categories: { id: 'text', code: 'text', name: 'text', is_active: 'bool' },
  bank_accounts: { id: 'text', code: 'text', name: 'text', kind: 'text', is_active: 'bool' },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type CashDeskDataset = keyof typeof CASH_DESK_COLUMNS;
export const CASH_DESK_DATASETS = Object.keys(CASH_DESK_COLUMNS) as CashDeskDataset[];

/**
 * The branch's bills of the last 90 days, for returns on every counter (SYN-01, sync spec §3, W1-13): headers, lines
 * and payments. Never the payload, signature, cost, cash figures or a payment's reference. The walk-in phone is
 * personal data: pulled for the lookup by phone, never logged or printed.
 */
export const RETURN_COLUMNS = {
  bills: {
    id: 'text',
    number: 'text',
    device_id: 'text',
    kind: 'text',
    status: 'text',
    business_date: 'text',
    created_at_device: 'text',
    customer_party_id: 'text',
    walkin_phone: 'text',
    total: 'money',
    return_of_id: 'text',
  },
  bill_lines: {
    id: 'text',
    document_id: 'text',
    line_no: 'int',
    item_id: 'text',
    qty: 'qty',
    unit_price: 'money',
    line_total: 'money',
    original_line_id: 'text',
  },
  bill_payments: { id: 'text', document_id: 'text', method_id: 'text', amount: 'money' },
} as const satisfies Record<string, Record<string, ColumnType>>;

export type ReturnDataset = keyof typeof RETURN_COLUMNS;
export const RETURN_DATASETS = Object.keys(RETURN_COLUMNS) as ReturnDataset[];
/** How far back the bills go (SYN-01). */
export const RETURN_BILL_DAYS = 90;

export const PULL_DATASETS = [
  'tenant',
  'branch',
  'users',
  'roles',
  'user_roles',
  ...(Object.keys(CATALOG_COLUMNS) as CatalogDataset[]),
  ...(Object.keys(CHECKOUT_COLUMNS) as CheckoutDataset[]),
  ...(Object.keys(CUSTOMER_COLUMNS) as CustomerDataset[]),
  ...(Object.keys(CASH_DESK_COLUMNS) as CashDeskDataset[]),
  ...(Object.keys(RETURN_COLUMNS) as ReturnDataset[]),
] as const;
export type PullDataset =
  | 'tenant'
  | 'branch'
  | 'users'
  | 'roles'
  | 'user_roles'
  | CatalogDataset
  | CheckoutDataset
  | CustomerDataset
  | CashDeskDataset
  | ReturnDataset;

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
