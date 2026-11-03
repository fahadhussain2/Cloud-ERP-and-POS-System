import type { RoleGrant, VoidWindow } from '../permissions';

// The counter, its staff and the bill they void, shared by the hold, void and reissue golden tests (W1-12). Each
// golden file's description names the same people.

export const COUNTER = '019a0000-0000-7000-8000-0000000000d1';
export const OTHER_COUNTER = '019a0000-0000-7000-8000-0000000000d2';
export const BRANCH = '019a0000-0000-7000-8000-0000000000e1';
const OTHER_BRANCH = '019a0000-0000-7000-8000-0000000000e2';

const grant = (
  permissions: string[],
  voidWindow: VoidWindow = 'none',
  branchId: string | null = null,
): RoleGrant[] => [{ permissions, limits: { maxDiscountBp: 10_000, voidWindow }, branchId }];

const SELL = ['pos.sale.create', 'pos.sale.hold'];

/**
 * …a1 a salesman; …a2 a manager (`pos.void`, before the handover); …a3 holds `pos.void` with the window `none`;
 * …a4 holds `pos.void` with the window `same_day`; …a5 a cashier; …a6 sells but can't hold; …a8 a manager of another
 * branch only. …a9 is unknown.
 */
export const STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000a1': grant(SELL),
  '019a0000-0000-7000-8000-0000000000a2': grant([...SELL, 'pos.void'], 'same_day_before_handover'),
  '019a0000-0000-7000-8000-0000000000a3': grant([...SELL, 'pos.void'], 'none'),
  '019a0000-0000-7000-8000-0000000000a4': grant([...SELL, 'pos.void'], 'same_day'),
  '019a0000-0000-7000-8000-0000000000a5': grant([...SELL, 'cash.handover.receive']),
  '019a0000-0000-7000-8000-0000000000a6': grant(['pos.sale.create']),
  '019a0000-0000-7000-8000-0000000000a8': grant(
    [...SELL, 'pos.void'],
    'same_day_before_handover',
    OTHER_BRANCH,
  ),
};
export const grantsOf = (userId: string): readonly RoleGrant[] => STAFF[userId] ?? [];

export const CONTEXT = {
  id: '019a8000-0000-7000-8000-000000000081',
  deviceId: COUNTER,
  deviceCode: 'C03',
  branchId: BRANCH,
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  clientVersion: '0.9.0',
};
