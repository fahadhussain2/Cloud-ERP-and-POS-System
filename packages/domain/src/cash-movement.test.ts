import documentCases from '../golden/cash-movement-document.json';
import checkCases from '../golden/cash-movement.json';
import {
  buildCashMovementDocument,
  checkCashMovement,
  type CashMovementInput,
  type CashOutKind,
  type MovementBankAccount,
  type MovementCategory,
} from './cash-movement';
import type { DeskSession } from './cash-session';
import { money, type Money } from './money';
import { BRANCH, CASHIER, CONTEXT, grantsOf, RS, SESSION } from './testing/desk';
import { runGolden, type GoldenFile } from './testing/golden';

const CATEGORIES: Record<string, MovementCategory> = {
  tea: { id: '019a1000-0000-7000-8000-000000000201', name: 'Tea', isActive: true },
  old: { id: '019a1000-0000-7000-8000-000000000202', name: 'Old', isActive: false },
};
const SUPPLIER = { partyId: '019a3000-0000-7000-8000-0000000000c2', code: 'S0007', name: 'Addi Traders' };
const BANKS: Record<string, MovementBankAccount> = {
  soneri: { id: '019a1000-0000-7000-8000-000000000301', name: 'Soneri', kind: 'bank', isActive: true },
  jazzcash: { id: '019a1000-0000-7000-8000-000000000302', name: 'JazzCash', kind: 'wallet', isActive: true },
  closed: { id: '019a1000-0000-7000-8000-000000000303', name: 'Old bank', kind: 'bank', isActive: false },
};

interface Case {
  session?: DeskSession | null;
  cashierId?: string;
  kind: CashOutKind;
  amount: Money;
  category?: string;
  supplier?: boolean;
  bank?: string;
  note?: string;
  reference?: string;
  expected?: Money;
  confirmed?: boolean;
}

const inputOf = (i: Case): CashMovementInput => {
  const cashierId = i.cashierId ?? CASHIER;
  return {
    session: i.session === undefined ? SESSION : i.session,
    cashierId,
    grants: grantsOf(cashierId),
    branchId: BRANCH,
    increment: RS,
    kind: i.kind,
    amount: i.amount,
    expenseCategory: i.category === undefined ? null : CATEGORIES[i.category]!,
    supplier: i.supplier === true ? SUPPLIER : null,
    bankAccount: i.bank === undefined ? null : BANKS[i.bank]!,
    note: i.note ?? null,
    reference: i.reference ?? null,
    expected: i.expected ?? money(1000000),
    overDrawerConfirmed: i.confirmed ?? false,
  };
};

runGolden(checkCases as unknown as GoldenFile<Case>, (i) => checkCashMovement(inputOf(i)));

runGolden(documentCases as unknown as GoldenFile<Case & { seq: number; createdAt: string }>, (i) =>
  buildCashMovementDocument({
    ...inputOf(i),
    context: { ...CONTEXT, seq: i.seq, createdAtMs: Date.parse(i.createdAt) },
  }),
);
