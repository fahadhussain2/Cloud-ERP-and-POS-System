import type { RoleGrant } from '../permissions';
import { BRANCH } from './counter';

// The people of the return golden tests (W1-13). Each golden file's description names the same people.

const OTHER_BRANCH = '019a0000-0000-7000-8000-0000000000e2';

const grant = (permissions: string[], branchId: string | null = null): RoleGrant[] => [
  { permissions, limits: { maxDiscountBp: 10_000, voidWindow: 'none' }, branchId },
];

const SELL = ['pos.sale.create', 'pos.sale.hold'];
const MANAGES = [
  ...SELL,
  'pos.return.create',
  'pos.return.no_receipt',
  'pos.return.outside_policy',
  'pos.override.approve',
];

/**
 * …f1 a salesman who may process returns (the Delux default, D-051); …f2 a salesman who may not; …f3 a manager
 * (returns, no receipt, out of policy, override approval); …f4 a senior salesman (returns only); …f5 a manager of
 * another branch only; …f6 a cashier (returns and the cash desk, no override approval).
 */
export const RETURN_STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000f1': grant([...SELL, 'pos.return.create']),
  '019a0000-0000-7000-8000-0000000000f2': grant(SELL),
  '019a0000-0000-7000-8000-0000000000f3': grant(MANAGES, BRANCH),
  '019a0000-0000-7000-8000-0000000000f4': grant([...SELL, 'pos.return.create']),
  '019a0000-0000-7000-8000-0000000000f5': grant(MANAGES, OTHER_BRANCH),
  '019a0000-0000-7000-8000-0000000000f6': grant([
    ...SELL,
    'pos.return.create',
    'cash.handover.receive',
    'cash.refund.pay',
  ]),
};
export const returnGrantsOf = (userId: string): readonly RoleGrant[] => RETURN_STAFF[userId] ?? [];
