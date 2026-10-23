// Permissions, role templates and limits (PRD §4, architecture §6.3, D-026, D-051, D-081).
// The POS (offline) and the API evaluate them with the same functions (CLAUDE.md rule 2).

/** Every permission there is. Routes and screens accept only these keys. */
export const PERMISSIONS = [
  // POS selling
  'pos.sale.create',
  'pos.sale.hold',
  'pos.price.below_floor',
  'pos.credit.sell',
  'pos.credit.over_limit',
  'pos.void',
  'pos.return.create',
  'pos.return.no_receipt',
  'pos.return.outside_policy',
  'pos.override.approve',
  // Cash desk
  'cash.handover.receive',
  'cash.refund.pay',
  'cash.collection.receive',
  'cash.movement.create',
  'cash.session.close',
  'cash.variance.approve',
  // Catalog and stock
  'cat.item.edit',
  'cat.price.edit',
  'cat.label.print',
  'inv.adjust',
  'inv.transfer',
  'inv.count',
  // Purchasing
  'pur.order.create',
  'pur.receive',
  'pur.reprice.propose',
  'pur.reprice.approve',
  // Accounting
  'acc.receipt.create',
  'acc.payment.create',
  'acc.expense.create',
  'acc.journal.post',
  'acc.period.close',
  // Visibility and administration
  'cost.view',
  'reports.view',
  'reports.financial',
  'admin.users',
  'admin.roles',
  'admin.settings',
  'admin.devices',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const CATALOG = new Set<string>(PERMISSIONS);
export const isPermission = (value: string): value is Permission => CATALOG.has(value);

/** How long after a sale it may still be voided (PRD W5, D-007). */
export type VoidWindow = 'none' | 'same_day_before_handover' | 'same_day';
const VOID_WINDOWS: readonly VoidWindow[] = ['none', 'same_day_before_handover', 'same_day'];

export interface RoleLimits {
  /** Largest discount below list price without an override, in basis points; the floor price still applies. */
  maxDiscountBp: number;
  voidWindow: VoidWindow;
}

export interface RoleTemplate {
  /** `*` means every permission, including ones added later (Owner only). */
  permissions: readonly (Permission | '*')[];
  limits: RoleLimits;
}

export type RoleTemplateKey = 'owner' | 'manager' | 'cashier' | 'salesman' | 'purchaser' | 'accountant';

const SELL: Permission[] = ['pos.sale.create', 'pos.sale.hold', 'pos.credit.sell', 'pos.return.create'];

/** The role templates from PRD §4. Tenants copy them into custom roles (PLT-06). */
export const ROLE_TEMPLATES: Readonly<Record<RoleTemplateKey, RoleTemplate>> = {
  owner: { permissions: ['*'], limits: { maxDiscountBp: 10_000, voidWindow: 'same_day' } },
  manager: {
    permissions: [
      ...SELL,
      'pos.price.below_floor',
      'pos.credit.over_limit',
      'pos.void',
      'pos.return.no_receipt',
      'pos.return.outside_policy',
      'pos.override.approve',
      'cash.variance.approve',
      'cat.item.edit',
      'cat.price.edit',
      'cat.label.print',
      'inv.adjust',
      'inv.transfer',
      'inv.count',
      'pur.order.create',
      'pur.receive',
      'pur.reprice.approve',
      'cost.view',
      'reports.view',
      'admin.devices',
    ],
    limits: { maxDiscountBp: 10_000, voidWindow: 'same_day' },
  },
  cashier: {
    permissions: [
      ...SELL,
      'cash.handover.receive',
      'cash.refund.pay',
      'cash.collection.receive',
      'cash.movement.create',
      'cash.session.close',
    ],
    limits: { maxDiscountBp: 10_000, voidWindow: 'none' },
  },
  // Discount down to the floor; returns on by default (D-051); no voids.
  salesman: { permissions: SELL, limits: { maxDiscountBp: 10_000, voidWindow: 'none' } },
  purchaser: {
    permissions: [
      'pur.order.create',
      'pur.receive',
      'pur.reprice.propose',
      'cat.item.edit',
      'cat.label.print',
      'inv.transfer',
      'inv.count',
      'cost.view',
      'reports.view',
    ],
    limits: { maxDiscountBp: 0, voidWindow: 'none' },
  },
  accountant: {
    permissions: [
      'acc.receipt.create',
      'acc.payment.create',
      'acc.expense.create',
      'acc.journal.post',
      'acc.period.close',
      'cost.view',
      'reports.view',
      'reports.financial',
    ],
    limits: { maxDiscountBp: 0, voidWindow: 'none' },
  },
};

/** A role assigned to a user; `branchId: null` means every branch. */
export interface RoleGrant {
  permissions: readonly string[];
  limits: RoleLimits;
  branchId: string | null;
}

const applies = (g: RoleGrant, branchId: string | null) => g.branchId === null || g.branchId === branchId;

/** May the user do this, in this branch? (`branchId: null` = not branch-specific; only all-branch roles count.) */
export function can(grants: readonly RoleGrant[], permission: Permission, branchId: string | null): boolean {
  return grants.some(
    (g) => applies(g, branchId) && (g.permissions.includes('*') || g.permissions.includes(permission)),
  );
}

/** Every permission the user has here, as catalog keys (for screens and the "me" response). */
export function expandPermissions(grants: readonly RoleGrant[], branchId: string | null): Permission[] {
  return PERMISSIONS.filter((p) => can(grants, p, branchId));
}

/** Several roles combine to the most permissive limit. */
export function effectiveLimits(grants: readonly RoleGrant[], branchId: string | null): RoleLimits {
  let limits: RoleLimits = { maxDiscountBp: 0, voidWindow: 'none' };
  for (const g of grants) {
    if (!applies(g, branchId)) continue;
    limits = {
      maxDiscountBp: Math.max(limits.maxDiscountBp, g.limits.maxDiscountBp),
      voidWindow:
        VOID_WINDOWS.indexOf(g.limits.voidWindow) > VOID_WINDOWS.indexOf(limits.voidWindow)
          ? g.limits.voidWindow
          : limits.voidWindow,
    };
  }
  return limits;
}
