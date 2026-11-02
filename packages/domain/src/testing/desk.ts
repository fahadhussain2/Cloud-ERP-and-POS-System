import type { DeskSession } from '../cash-session';
import { money } from '../money';
import type { RoleGrant } from '../permissions';

// The desk, its staff and its open session, shared by the cash desk golden tests (W1-10, W1-11). Each golden file's
// description names the same people.

export const RS = money(100);
export const DESK = '019a0000-0000-7000-8000-0000000000d9';
export const BRANCH = '019a0000-0000-7000-8000-0000000000e1';
export const CASHIER = '019a0000-0000-7000-8000-0000000000a5';

const grant = (permissions: string[]): RoleGrant[] => [
  { permissions, limits: { maxDiscountBp: 1000, voidWindow: 'none' }, branchId: null },
];

const CASH_DESK = [
  'pos.sale.create',
  'cash.handover.receive',
  'cash.refund.pay',
  'cash.collection.receive',
  'cash.movement.create',
  'cash.session.close',
];

/** …a1 a salesman; …a2 a manager; …a5 a cashier; …a6 receives handovers only; …a7 a senior cashier who may also approve variances. …a9 is unknown. */
export const STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000a1': grant(['pos.sale.create']),
  '019a0000-0000-7000-8000-0000000000a2': grant([
    'pos.sale.create',
    'cash.session.close',
    'cash.variance.approve',
  ]),
  [CASHIER]: grant(CASH_DESK),
  '019a0000-0000-7000-8000-0000000000a6': grant(['cash.handover.receive']),
  '019a0000-0000-7000-8000-0000000000a7': grant([...CASH_DESK, 'cash.variance.approve']),
};
export const grantsOf = (userId: string): readonly RoleGrant[] => STAFF[userId] ?? [];

export const SESSION: DeskSession = {
  id: '019a6000-0000-7000-8000-000000000051',
  cashierId: CASHIER,
  openingFloat: money(500000),
  status: 'open',
};

export const CONTEXT = {
  id: '019a7000-0000-7000-8000-000000000071',
  deviceId: DESK,
  deviceCode: 'D01',
  branchId: BRANCH,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.8.0',
};
