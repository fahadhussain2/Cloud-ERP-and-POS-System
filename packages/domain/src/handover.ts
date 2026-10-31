import { businessDate } from './business-date';
import type { DeskContext, DeskSession } from './cash-session';
import { DomainError } from './errors';
import { add, money, negate, sub, type Money } from './money';
import { can, type Permission, type RoleGrant } from './permissions';
import { documentNumber } from './sale-document';

// Cash handovers at the desk (CSH-02, CSH-03, CSH-04, PRD W4, W7, cash desk spec): the live queue, the check before a
// handover is recorded, the handover document, and the server's review of it. A bill's positive cash due is handed in;
// a negative one (a refund) is paid out. A handover is its own document: the sale is never touched (CLAUDE.md rule 3).
// The server flags what looks wrong, never refuses (D-011, D-059).

export type HandoverKind = 'in' | 'payout';
/** `auto`: a cash sale on the desk itself (PRD W4.5, owner answer 4 to W1-10). */
export type HandoverMethod = 'queue' | 'scan' | 'auto';
export type HandoverStatus = 'not_applicable' | 'pending' | 'received' | 'paid_out';

/** A pulled `cash_queue` row (sync spec §3), as the queue needs it. */
export interface QueueEntry {
  id: string;
  number: string;
  sellerId: string;
  createdAt: string;
  /** Negative = a refund. */
  cashDue: Money;
  /** The salesman's figure; null = the exact amount. */
  cashReceived: Money | null;
  changeDue: Money | null;
  handoverStatus: HandoverStatus;
  status: 'finalized' | 'voided';
}

/** A handover this desk has written, still or already in its outbox. */
export interface LocalHandover {
  billNumber: string;
  kind: HandoverKind;
  number: string;
  cashierId: string;
  at: string;
}

export interface QueueBill {
  id: string;
  number: string;
  createdAt: string;
  kind: HandoverKind;
  /** Always positive: the cash to take in, or to pay out. */
  amount: Money;
  cashReceived: Money | null;
  changeDue: Money | null;
}

export interface QueueGroup {
  sellerId: string;
  /** null when the desk has no name for them. */
  sellerName: string | null;
  /** Oldest first. */
  bills: QueueBill[];
  toCollect: Money;
  toPayOut: Money;
}

const kindOf = (cashDue: Money): HandoverKind => (cashDue < 0 ? 'payout' : 'in');
const abs = (m: Money): Money => (m < 0 ? negate(m) : m);

/**
 * The pending bills and refunds, minus those this desk has handed over already, grouped by salesman: by name, unknown
 * names last.
 */
export function queueGroups(input: {
  entries: readonly QueueEntry[];
  local: readonly LocalHandover[];
  sellers: Readonly<Record<string, string>>;
}): QueueGroup[] {
  const done = new Set(input.local.map((h) => h.billNumber));
  const groups = new Map<string, QueueGroup>();
  const pending = input.entries
    .filter((e) => e.status === 'finalized' && e.handoverStatus === 'pending' && e.cashDue !== 0)
    .filter((e) => !done.has(e.number))
    // Oldest first; two bills of one second by number (numbers are unique, so no two keys are equal).
    .sort((a, b) => (`${a.createdAt} ${a.number}` < `${b.createdAt} ${b.number}` ? -1 : 1));
  for (const e of pending) {
    const group = groups.get(e.sellerId) ?? {
      sellerId: e.sellerId,
      sellerName: input.sellers[e.sellerId] ?? null,
      bills: [],
      toCollect: money(0),
      toPayOut: money(0),
    };
    const kind = kindOf(e.cashDue);
    const amount = abs(e.cashDue);
    group.bills.push({
      id: e.id,
      number: e.number,
      createdAt: e.createdAt,
      kind,
      amount,
      cashReceived: e.cashReceived,
      changeDue: e.changeDue,
    });
    if (kind === 'in') group.toCollect = add(group.toCollect, amount);
    else group.toPayOut = add(group.toPayOut, amount);
    groups.set(e.sellerId, group);
  }
  // Named first, by name, then by id: seller ids are unique, so no two keys are equal.
  const key = (g: QueueGroup) => `${g.sellerName === null ? 1 : 0}\n${g.sellerName ?? ''}\n${g.sellerId}`;
  return [...groups.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

/** The bill a handover is for: a queue row, or only what a scanned code says (`saleDocumentId` null). */
export interface HandoverTarget {
  number: string;
  /** Negative = a refund. */
  cashDue: Money;
  saleDocumentId: string | null;
  /** The salesman's figure; null = exact, or unknown for a bill known only from its code. */
  cashReceived: Money | null;
  /** As the server last said; a bill known only from its code is `pending`. */
  handoverStatus: HandoverStatus;
}

export interface HandoverInput {
  /** This desk's current session. */
  session: DeskSession | null;
  cashierId: string;
  grants: readonly RoleGrant[];
  branchId: string;
  /** The tenant's cash rounding increment (Delux: 100 = Rs 1). */
  increment: Money;
  target: HandoverTarget;
  /** The cashier's correction of the cash received (or, for a bill known only from its code, the figure typed). */
  cashReceived: Money | null;
  /** This desk's handovers, to refuse a second one. */
  existing: readonly LocalHandover[];
}

export type HandoverProblem =
  | 'nothing_to_collect'
  | 'no_session'
  | 'not_session_cashier'
  | 'not_permitted'
  | 'already_handed_over'
  | 'received_not_rounded'
  | 'received_short';

export type HandoverCheck =
  | {
      ok: true;
      kind: HandoverKind;
      /** The posted figure: the cash due, or the refund, as a positive amount. */
      amount: Money;
      /** null on a payout, and on a code-only bill without a typed figure. */
      cashReceived: Money | null;
      changeGiven: Money | null;
      /** The salesman's figure, when the cashier changed it. */
      correctedFrom: Money | null;
    }
  | { ok: false; problem: Exclude<HandoverProblem, 'not_permitted' | 'already_handed_over'> }
  | { ok: false; problem: 'not_permitted'; permission: Permission }
  | {
      ok: false;
      problem: 'already_handed_over';
      /** The handover on this desk, or null when the server says the bill is done. */
      existing: { number: string; cashierId: string; at: string } | null;
    };

const permissionFor = (kind: HandoverKind): Permission =>
  kind === 'in' ? 'cash.handover.receive' : 'cash.refund.pay';

/** May this cashier record this handover now, and what is recorded? The first problem found, in a fixed order. */
export function checkHandover(input: HandoverInput): HandoverCheck {
  const { session, target } = input;
  if (target.cashDue === 0) return { ok: false, problem: 'nothing_to_collect' };
  if (session === null || session.status !== 'open') return { ok: false, problem: 'no_session' };
  if (session.cashierId !== input.cashierId) return { ok: false, problem: 'not_session_cashier' };
  const kind = kindOf(target.cashDue);
  const permission = permissionFor(kind);
  if (!can(input.grants, permission, input.branchId))
    return { ok: false, problem: 'not_permitted', permission };
  const mine = input.existing.find((h) => h.billNumber === target.number && h.kind === kind);
  if (mine !== undefined)
    return {
      ok: false,
      problem: 'already_handed_over',
      existing: { number: mine.number, cashierId: mine.cashierId, at: mine.at },
    };
  if (target.handoverStatus === 'received' || target.handoverStatus === 'paid_out')
    return { ok: false, problem: 'already_handed_over', existing: null };
  const amount = abs(target.cashDue);
  if (kind === 'payout')
    return { ok: true, kind, amount, cashReceived: null, changeGiven: null, correctedFrom: null };

  const corrected = input.cashReceived;
  if (corrected !== null) {
    if (corrected % input.increment !== 0) return { ok: false, problem: 'received_not_rounded' };
    if (corrected < amount) return { ok: false, problem: 'received_short' };
  }
  if (target.saleDocumentId === null) {
    // Known only from its code: nothing to correct, only what the cashier typed (if anything).
    return {
      ok: true,
      kind,
      amount,
      cashReceived: corrected,
      changeGiven: corrected === null ? null : sub(corrected, amount),
      correctedFrom: null,
    };
  }
  const salesman = target.cashReceived ?? amount;
  const received = corrected ?? salesman;
  return {
    ok: true,
    kind,
    amount,
    cashReceived: received,
    changeGiven: sub(received, amount),
    correctedFrom: corrected !== null && corrected !== salesman ? salesman : null,
  };
}

/** `CashHandoverV1` in `@erp/contracts` is its wire schema (cash desk spec, data model §6). */
export interface CashHandoverDocument {
  version: 1;
  id: string;
  family: 'H';
  seq: number;
  number: string;
  kind: HandoverKind;
  deviceId: string;
  branchId: string;
  sessionId: string;
  cashierId: string;
  billNumber: string;
  /** null when the desk knew the bill only from its code; the server links it when the bill arrives. */
  saleDocumentId: string | null;
  /** The posted figure (positive). */
  amount: Money;
  cashReceived: Money | null;
  changeGiven: Money | null;
  correctedFrom: Money | null;
  method: HandoverMethod;
  createdAt: string;
  businessDate: string;
  clientVersion: string;
}

/** The handover document, or the check's problem as a DomainError. */
export function buildHandoverDocument(
  input: HandoverInput & { method: HandoverMethod; context: DeskContext },
): CashHandoverDocument {
  const check = checkHandover(input);
  if (!check.ok)
    throw new DomainError(check.problem, `no handover for ${input.target.number}: ${check.problem}`);
  const c = input.context;
  return {
    version: 1,
    id: c.id,
    family: 'H',
    seq: c.seq,
    number: documentNumber(c.deviceCode, 'H', c.seq),
    kind: check.kind,
    deviceId: c.deviceId,
    branchId: c.branchId,
    // checkHandover has refused without an open session.
    sessionId: input.session!.id,
    cashierId: input.cashierId,
    billNumber: input.target.number,
    saleDocumentId: input.target.saleDocumentId,
    amount: check.amount,
    cashReceived: check.cashReceived,
    changeGiven: check.changeGiven,
    correctedFrom: check.correctedFrom,
    method: input.method,
    createdAt: new Date(c.createdAtMs).toISOString(),
    businessDate: businessDate(c.createdAtMs, c.timeZone, c.cutoffHour),
    clientVersion: c.clientVersion,
  };
}

export type HandoverFinding =
  | { kind: 'duplicate_handover'; duplicateOf: string; duplicateOfNumber: string }
  | { kind: 'handover_amount_mismatch'; handoverKind: HandoverKind; amount: Money; billCashDue: Money }
  | { kind: 'handover_not_permitted'; permission: Permission };

/**
 * The server's findings on a pushed handover (sync spec §6.2), in this order: a second handover of the bill, an
 * amount or direction that doesn't match the bill (once the bill is there), a cashier without the permission.
 */
export function reviewHandover(
  handover: CashHandoverDocument,
  context: {
    /** The stored bill, or null until it arrives. */
    bill: { id: string; cashDue: Money } | null;
    /** An earlier handover of the same bill and kind that isn't itself a duplicate. */
    existing: { id: string; number: string } | null;
    /** The roles the server holds for the cashier. */
    grants: readonly RoleGrant[];
    branchId: string;
  },
): HandoverFinding[] {
  const findings: HandoverFinding[] = [];
  if (context.existing !== null && context.existing.id !== handover.id)
    findings.push({
      kind: 'duplicate_handover',
      duplicateOf: context.existing.id,
      duplicateOfNumber: context.existing.number,
    });
  if (context.bill !== null) {
    const signed = handover.kind === 'in' ? handover.amount : negate(handover.amount);
    if (context.bill.cashDue !== signed)
      findings.push({
        kind: 'handover_amount_mismatch',
        handoverKind: handover.kind,
        amount: handover.amount,
        billCashDue: context.bill.cashDue,
      });
  }
  const permission = permissionFor(handover.kind);
  if (!can(context.grants, permission, context.branchId))
    findings.push({ kind: 'handover_not_permitted', permission });
  return findings;
}
