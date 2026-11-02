import documentCases from '../golden/collection-document.json';
import checkCases from '../golden/collection.json';
import type { DeskSession } from './cash-session';
import {
  buildCollectionDocument,
  checkCollection,
  type CollectionCustomer,
  type CollectionInput,
  type CollectionMethod,
} from './collection';
import { money, type Money } from './money';
import { BRANCH, CASHIER, CONTEXT, grantsOf, RS, SESSION } from './testing/desk';
import { runGolden, type GoldenFile } from './testing/golden';

const CUSTOMERS: Record<string, CollectionCustomer> = {
  ali: {
    partyId: '019a3000-0000-7000-8000-0000000000c1',
    code: 'C0042',
    name: 'Ali Autos',
    balance: money(1250000),
  },
  bilal: {
    partyId: '019a3000-0000-7000-8000-0000000000c3',
    code: 'C0051',
    name: 'Bilal Motors',
    balance: money(-100000),
  },
};

const METHODS: Record<string, CollectionMethod> = {
  cash: {
    id: '019a1000-0000-7000-8000-000000000101',
    code: 'cash',
    isCash: true,
    requiresReference: false,
    isActive: true,
  },
  raast: {
    id: '019a1000-0000-7000-8000-000000000102',
    code: 'raast',
    isCash: false,
    requiresReference: true,
    isActive: true,
  },
  on_account: {
    id: '019a1000-0000-7000-8000-000000000103',
    code: 'on_account',
    isCash: false,
    requiresReference: false,
    isActive: true,
  },
  card: {
    id: '019a1000-0000-7000-8000-000000000104',
    code: 'card',
    isCash: false,
    requiresReference: true,
    isActive: false,
  },
};

interface Case {
  session?: DeskSession | null;
  cashierId?: string;
  customer?: string | null;
  method: string | null;
  amount: Money;
  reference?: string;
  note?: string;
}

const inputOf = (i: Case): CollectionInput => {
  const cashierId = i.cashierId ?? CASHIER;
  const customer = i.customer === undefined ? 'ali' : i.customer;
  return {
    session: i.session === undefined ? SESSION : i.session,
    cashierId,
    grants: grantsOf(cashierId),
    branchId: BRANCH,
    increment: RS,
    customer: customer === null ? null : CUSTOMERS[customer]!,
    method: i.method === null ? null : METHODS[i.method]!,
    amount: i.amount,
    reference: i.reference ?? null,
    note: i.note ?? null,
  };
};

runGolden(checkCases as unknown as GoldenFile<Case>, (i) => checkCollection(inputOf(i)));

runGolden(documentCases as unknown as GoldenFile<Case & { seq: number; createdAt: string }>, (i) =>
  buildCollectionDocument({
    ...inputOf(i),
    context: { ...CONTEXT, seq: i.seq, createdAtMs: Date.parse(i.createdAt) },
  }),
);
