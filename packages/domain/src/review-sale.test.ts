import reviewCases from '../golden/review-sale.json';
import { money } from './money';
import type { RoleGrant } from './permissions';
import { reviewSale } from './review-sale';
import type { SaleDocument } from './sale-document';
import { runGolden, type GoldenFile } from './testing/golden';
import { DELUX_METHODS } from './testing/methods';

// The staff the server knows (see the golden file's description); …a9 has no roles.
const grant = (permissions: string[], maxDiscountBp: number): RoleGrant[] => [
  { permissions, limits: { maxDiscountBp, voidWindow: 'none' }, branchId: null },
];
const STAFF: Record<string, readonly RoleGrant[]> = {
  '019a0000-0000-7000-8000-0000000000a1': grant(['pos.sale.create'], 1000),
  '019a0000-0000-7000-8000-0000000000a2': grant(
    ['pos.sale.create', 'pos.override.approve', 'pos.price.below_floor'],
    5000,
  ),
  '019a0000-0000-7000-8000-0000000000a3': grant(['pos.sale.create', 'pos.override.approve'], 2000),
  '019a0000-0000-7000-8000-0000000000a4': grant(['pos.sale.create'], 0),
};

runGolden(reviewCases as unknown as GoldenFile<{ document: SaleDocument }>, (i) =>
  reviewSale(i.document, {
    deviceCode: 'C03',
    timeZone: 'Asia/Karachi',
    cutoffHour: 4,
    increment: money(100),
    methods: DELUX_METHODS,
    grants: STAFF,
  }),
);
