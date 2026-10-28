import type { RoleGrant } from './permissions';
import type { Money } from './money';
import type { SaleDocument } from './sale-document';
import type { PaymentMethodInfo, TenderProblem } from './tender';

// The server's re-check of a synced sale (sync spec §6.2, SYN-03, D-011, W1-07): the same rules the counter used,
// run again on the document as it arrived. It never refuses a sale; it returns findings, which the server records as
// exceptions for review. Prices and floors are judged on the document's own snapshot (architecture §4.7); approvals
// are judged against the roles the server holds for each person.

/** What doesn't add up on a document (`document_inconsistent`), in the order they are checked. */
export type InconsistencyCode =
  | 'number'
  | 'business_date'
  | 'line_numbers'
  | 'line_amounts'
  | 'amounts'
  | 'rounding'
  | 'tender'
  | 'payments'
  | 'cash_due'
  | 'handover_status';

/** Why a price that needed an approval isn't covered. */
export type ApprovalCause = 'no_approval' | 'not_covered' | 'not_permitted';

export type SaleFinding =
  | {
      kind: 'document_inconsistent';
      /** The line, for `line_amounts`; else null. */
      lineNo: number | null;
      code: InconsistencyCode;
      /** The tender problem, for `tender`; else null. */
      problem: TenderProblem | null;
    }
  | {
      kind: 'below_floor_no_override' | 'discount_over_limit';
      /** null for the bill discount. */
      lineNo: number | null;
      /** The discount below list in basis points; null when the line has no list price. */
      discountBp: number | null;
      cause: ApprovalCause;
    };

export interface ReviewContext {
  /** The code of the device the document says made it. */
  deviceCode: string;
  timeZone: string;
  cutoffHour: number;
  increment: Money;
  /** Every payment method of the tenant, active or not: one switched off during an outage is not a finding. */
  methods: readonly PaymentMethodInfo[];
  /** The roles the server holds, by user id, for the seller and every approver on the document. */
  grants: Readonly<Record<string, readonly RoleGrant[]>>;
}

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-07): ${args.length} arguments`);
};

/** The findings on a synced sale: consistency first, in `InconsistencyCode` order, then prices (lines, then the bill). */
export function reviewSale(document: SaleDocument, context: ReviewContext): SaleFinding[] {
  return notBuilt(document, context);
}
