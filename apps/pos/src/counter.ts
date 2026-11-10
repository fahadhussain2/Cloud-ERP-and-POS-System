import type { CounterPinChangeRequest } from '@erp/contracts';
import type {
  CashHandoverDocument,
  CashMovementDocument,
  CashSessionDocument,
  CustomerCollectionDocument,
  CreditView,
  Money,
  PinState,
  RoleGrant,
  AnySaleDocument,
  ItemPolicy,
  SaleVoidDocument,
} from '@erp/domain';

import type { OpenBill } from './bill/open-bill';
import type { CheckoutSettings, DocumentSummary, FinalizeRequest, Finalized, Reprint } from './db/checkout';
import type { CounterCustomer } from './db/customers';
import type {
  CashMovementRequest,
  CloseRequest,
  CollectionRequest,
  DeskCustomer,
  DeskLookups,
  DeskState,
  HandoverRequest,
} from './db/desk';
import type { HeldBill } from './db/held';
import type { FoundBill, ReturnableBill } from './db/returns';
import type { LocalHealth, QuarantinedRow } from './db/outbox';
import type { VoidListBill, VoidRequest } from './db/void';
import type { DiagnosticsResult } from './sync/diagnostics';
import type { DeviceInfo, PinEvent, TenantSettings } from './db/repo';
import type { EnrollResult } from './device/session';
import type { DeskPrintJob } from './print/DeskSlipPrint';
import type { PrintJob } from './print/print-job';
import type { BillItem, SearchOptions, SearchResult, Tier } from './search/search-index';
import type { CheckResult } from './storage/checks';
import type { DeskCheck } from './sync/bills';
import type { PinChangeResult } from './sync/pin';
import type { PullResult } from './sync/pull';
import type { PushOutcome } from './sync/push';
import type { StaffUser } from './unlock/unlock';

// Everything the counter screens need from the PC and the server, in one place, so the screens can be tested with a
// fake. The real one is browserCounter() (counter-browser.ts).

export interface CounterStatus {
  /** Bills not yet on the server, refused ones included. */
  outboxCount: number;
  lastSyncAt: string | null;
  /** The last successful push or pull: the offline warnings count from it (SYN-06). */
  lastContactAt: string | null;
  /** Bills the server refused (Needs attention). */
  attention: number;
}

export interface CounterHealth extends LocalHealth {
  appVersion: string;
  schemaVersion: number;
  /** From the browser; null when it can't say. */
  storagePersisted: boolean | null;
  storageUsage: number | null;
  storageQuota: number | null;
  /** The server's clock minus this counter's, at the last push; null before one. */
  serverOffsetMs: number | null;
}

export interface Counter {
  checkStorage(): Promise<CheckResult>;
  device(): Promise<DeviceInfo | null>;
  enroll(input: { tenantCode: string; code: string }): Promise<EnrollResult>;
  /** Pulls until up to date; `onPage` runs after each page is stored. */
  pull(onPage?: () => void): Promise<PullResult>;
  staff(): Promise<StaffUser[]>;
  settings(): Promise<TenantSettings | null>;
  getPinState(userId: string): Promise<PinState>;
  setPinState(userId: string, state: PinState): Promise<void>;
  verifyPin(verifier: string, pin: string): Promise<boolean>;
  /** A person's roles here, from the pulled roles (the manager unlock checks admin.devices, W1-04). */
  grants(userId: string): Promise<RoleGrant[]>;
  /** Keeps a lock or a manager unlock for the server's audit log (pushed with W1-07). */
  recordPinEvent(event: Omit<PinEvent, 'id' | 'pushedAt'>): Promise<void>;
  changePin(body: CounterPinChangeRequest): Promise<PinChangeResult>;
  status(): Promise<CounterStatus>;
  /** Pushes the outbox, the audit events and the health; an empty outbox is the handshake (sync spec §6.2, W1-07). */
  push(): Promise<PushOutcome>;
  /** Opens the SSE nudge (sync spec §8); returns the close. */
  listen(handlers: { onChanges: () => void; onConnected: (connected: boolean) => void }): () => void;
  /** This counter's health (PLT-09, POS spec §14). */
  health(): Promise<CounterHealth>;
  /** Bills the server refused, waiting under Needs attention. */
  needsAttention(): Promise<QuarantinedRow[]>;
  /** Puts a refused bill back in the queue (a manager's *Try again*). */
  retryBill(id: string): Promise<boolean>;
  /** Drops this counter's documents older than 30 days, never one still to sync (rule 9). */
  prune(): Promise<number>;
  log(kind: string, detail: Record<string, unknown>): Promise<void>;
  /** Sends this counter's log and health to support, as the manager who unlocked it (PLT-12, W1-20). */
  sendDiagnostics(sentByUserId: string): Promise<DiagnosticsResult>;
  /** Omni-search over the local catalog (POS spec §9). */
  search(text: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** How much of the catalog is on this counter, and whether its first load has finished. */
  catalog(): Promise<{ items: number; ready: boolean }>;
  /** The price tiers, in order (POS spec §10). */
  tiers(): Promise<Tier[]>;
  /** An item as a bill line takes it: its price in the tier (or the default tier's), floor and unit. */
  billItem(itemId: string, tierId: string | null): Promise<BillItem | null>;
  /** Items' list prices in another tier, for a tier change. */
  tierPrices(itemIds: string[], tierId: string): Promise<Record<string, Money | null>>;
  /** A person's open bill on this counter, kept across lock and reload (POS spec §10). */
  openBill(userId: string): Promise<OpenBill | null>;
  saveOpenBill(userId: string, bill: OpenBill): Promise<void>;
  clearOpenBill(userId: string): Promise<void>;
  /** Holds the person's open bill and leaves an empty one (POS spec §17); refused with checkHold's problem. */
  holdBill(req: { userId: string; label: string | null }): Promise<HeldBill>;
  /** The person's held bills, newest first; the expired ones are swept first. */
  heldBills(userId: string): Promise<HeldBill[]>;
  /** Makes a held bill the open bill again; `swap` holds the open bill first when it has lines. */
  recallBill(req: { id: string; userId: string; swap: { label: string | null } | null }): Promise<OpenBill>;
  clearHeld(id: string, userId: string): Promise<boolean>;
  /** This counter's bills of today that aren't voided, newest first, for the Void dialog (POS spec §18). */
  voidableBills(filter: string): Promise<VoidListBill[]>;
  /** Has the cash desk taken this bill's cash? What this device knows itself, else the live check (unknown offline). */
  deskCheck(billNumber: string): Promise<DeskCheck>;
  /** Voids a bill in one local transaction, then signs the void; refused with checkVoid's problem as a DomainError. */
  voidBill(
    req: Omit<VoidRequest, 'id' | 'createdAtMs' | 'clientVersion'>,
  ): Promise<{ void: SaleVoidDocument; sale: AnySaleDocument }>;
  /** The void of a bill on this counter, for its prints, or null. */
  voidOf(saleId: string): Promise<SaleVoidDocument | null>;
  /** The bills a return search finds: by scanned code or number, date, or phone digits (POS spec §19, W1-13). */
  findBills(query: string): Promise<FoundBill[]>;
  /** A bill with what each of its lines can still give back; null when this counter doesn't have it. */
  returnableBill(id: string): Promise<ReturnableBill | null>;
  /** The refund per unit suggested without a receipt: the lowest price of the last 90 days, else today's price. */
  noReceiptPrice(itemId: string): Promise<Money | null>;
  /** The tenant's return window and each item's category policy. */
  returnPolicy(itemIds: string[]): Promise<{ windowDays: number; items: ItemPolicy[] }>;
  /** Rounding, business day, payment methods and the print profile; null before the first pull (POS spec §12). */
  checkout(): Promise<CheckoutSettings | null>;
  /** Finalizes the person's open bill in one local transaction, then signs it (POS spec §12). */
  finalize(req: FinalizeRequest): Promise<Finalized>;
  /** This counter's bills since `since`, newest first, for the reprint list (POS spec §13). */
  recentBills(since: string, filter: string): Promise<DocumentSummary[]>;
  bill(id: string): Promise<AnySaleDocument | null>;
  recordReprint(r: Omit<Reprint, 'id' | 'pushedAt'>): Promise<Reprint>;
  /** The customers the F4 dialog can pick, with their accounts and pulled balances (POS spec §15). */
  customers(): Promise<CounterCustomer[]>;
  /** A customer's credit figures now, as finalize will read them (POS spec §15). */
  creditFigures(customerId: string, offline: boolean): Promise<CreditView>;
  /** Prints a bill on the default printer (`window.print()` under `--kiosk-printing`, POS spec §13). */
  print(job: PrintJob): void;
  /** The cash desk (W1-10, cash desk spec): its session, the pulled queue and its own handovers. */
  deskState(): Promise<DeskState>;
  /** Opens a session with its float; the document is written with its outbox row, then signed. */
  openSession(req: { userId: string; openingFloat: Money }): Promise<CashSessionDocument>;
  /** Closes it with the drawer count (W1-11); refused with the close check's problem as a DomainError. */
  closeSession(req: Omit<CloseRequest, 'id' | 'createdAtMs' | 'clientVersion'>): Promise<CashSessionDocument>;
  /** Records a handover or a payout; refused with the check's problem as a DomainError. */
  confirmHandover(
    req: Omit<HandoverRequest, 'id' | 'createdAtMs' | 'clientVersion'>,
  ): Promise<CashHandoverDocument>;
  /** What the collection and cash-out dialogs offer (W1-11). */
  deskLookups(): Promise<DeskLookups>;
  /** A customer's balance as this desk knows it, and the last collection here. */
  deskCustomer(partyId: string): Promise<DeskCustomer | null>;
  receiveCollection(
    req: Omit<CollectionRequest, 'id' | 'createdAtMs' | 'clientVersion'>,
  ): Promise<CustomerCollectionDocument>;
  recordCashMovement(
    req: Omit<CashMovementRequest, 'id' | 'createdAtMs' | 'clientVersion'>,
  ): Promise<CashMovementDocument>;
  /** Prints a receipt, voucher or close slip like a bill. */
  printDesk(job: DeskPrintJob): void;
}
