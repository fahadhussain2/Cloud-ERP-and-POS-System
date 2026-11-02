// Chart-of-accounts rules (ACC-01, posting rules §2, data model §9, D-083). The posting engine relies on them:
// it finds accounts by system role, so each required role must exist exactly once, on a postable account.

export const SYSTEM_ROLES = [
  'CASH_DRAWER',
  'CASH_IN_TRANSIT',
  'AR_CONTROL',
  'AP_CONTROL',
  'INVENTORY',
  'COGS',
  'SALES',
  'SALES_RETURNS',
  'SALES_DISCOUNT',
  'ROUNDING',
  'CASH_SHORT_OVER',
  'INVENTORY_ADJUSTMENT',
  'PURCHASE_PRICE_VARIANCE',
  'OPENING_BALANCE_EQUITY',
  'RETAINED_EARNINGS',
  'TAX_PAYABLE',
  'TAX_RECOVERABLE',
  // The difference of a bill that doesn't add up, until the accountant clears it (owner answer 3 to W1-08).
  'SUSPENSE',
  // 1130 Cash in safe: what leaves the drawer at close, and the safe movements (owner answer 3 to W1-11).
  'CASH_SAFE',
] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Every role except input tax, which the MVP (no tax) doesn't use. */
export const REQUIRED_SYSTEM_ROLES: readonly SystemRole[] = SYSTEM_ROLES.filter(
  (r) => r !== 'TAX_RECOVERABLE',
);

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Charts come from templates and imports, so type and role are checked here rather than trusted. */
export interface ChartAccount {
  code: string;
  type: AccountType | (string & {});
  parentCode: string | null;
  isPostable: boolean;
  systemRole: SystemRole | (string & {}) | null;
}

export type ChartProblem =
  | { problem: 'missing_role'; role: SystemRole }
  | { problem: 'duplicate_role'; role: SystemRole; accounts: string[] }
  | {
      problem:
        | 'role_on_header'
        | 'type_mismatch'
        | 'postable_parent'
        | 'unknown_parent'
        | 'duplicate_code'
        | 'unknown_type'
        | 'unknown_role';
      account: string;
    };

const TYPES: ReadonlySet<string> = new Set(ACCOUNT_TYPES);
const ROLES: ReadonlySet<string> = new Set(SYSTEM_ROLES);

/** All problems with a chart, sorted (roles first, then by account code); an empty list means it's valid. */
export function validateChartOfAccounts(
  accounts: readonly ChartAccount[],
  required: readonly SystemRole[] = REQUIRED_SYSTEM_ROLES,
): ChartProblem[] {
  const problems: ChartProblem[] = [];
  const byCode = new Map<string, ChartAccount>();
  const duplicates = new Set<string>();
  for (const a of accounts) {
    if (!byCode.has(a.code)) byCode.set(a.code, a);
    else if (!duplicates.has(a.code)) {
      duplicates.add(a.code);
      problems.push({ problem: 'duplicate_code', account: a.code });
    }
  }

  const parents = new Set(accounts.flatMap((a) => (a.parentCode ? [a.parentCode] : [])));
  for (const a of byCode.values()) {
    if (!TYPES.has(a.type)) problems.push({ problem: 'unknown_type', account: a.code });
    if (a.systemRole !== null && !ROLES.has(a.systemRole))
      problems.push({ problem: 'unknown_role', account: a.code });
    if (a.parentCode !== null) {
      const parent = byCode.get(a.parentCode);
      if (!parent) problems.push({ problem: 'unknown_parent', account: a.code });
      else if (parent.type !== a.type) problems.push({ problem: 'type_mismatch', account: a.code });
    }
    if (parents.has(a.code) && a.isPostable) problems.push({ problem: 'postable_parent', account: a.code });
    if (a.systemRole !== null && !a.isPostable) problems.push({ problem: 'role_on_header', account: a.code });
  }

  for (const role of required) {
    const holders = [...byCode.values()].filter((a) => a.systemRole === role).map((a) => a.code);
    if (holders.length === 0) problems.push({ problem: 'missing_role', role });
    else if (holders.length > 1) problems.push({ problem: 'duplicate_role', role, accounts: holders.sort() });
  }

  const key = (p: ChartProblem) => ('role' in p ? `0 ${p.role}` : `1 ${p.account} ${p.problem}`);
  // Keys are unique: one problem of each kind per account or role.
  return problems.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}
