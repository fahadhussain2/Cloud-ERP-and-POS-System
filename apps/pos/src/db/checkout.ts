import type { Money, PaymentMethodInfo, SaleDocument, Tender } from '@erp/domain';

import type { SqlDb } from './sql';

// Paying, finalizing and reprinting on the counter (POS spec §12–§13, data model §12). Runs in the database worker.

/** An active payment method as pulled (sync spec §3), in its `sort` order. */
export interface PaymentMethodRow extends PaymentMethodInfo {
  id: string;
  name: string;
  sort: number;
}

export type PaperFormat = 'a4' | 'a5' | 'thermal_80' | 'thermal_58';

/** The print profile this counter uses: its own, else the tenant default (POS spec §13). */
export interface PrintProfile {
  id: string;
  name: string;
  paperFormat: PaperFormat;
  codeType: 'barcode' | 'signed_qr';
  copies: 1 | 2;
  headerLines: string[];
  policyText: string | null;
}

export interface CheckoutSettings {
  /** The tenant's cash rounding increment (Delux: 100 = Rs 1). */
  increment: Money;
  timeZone: string;
  cutoffHour: number;
  methods: PaymentMethodRow[];
  printProfile: PrintProfile | null;
}

export interface FinalizeRequest {
  /** Who is unlocked: their open bill is finalized. */
  userId: string;
  /** UUIDv7 for the document, made on the counter. */
  id: string;
  createdAtMs: number;
  clientVersion: string;
  tender: Tender;
}

export interface Finalized {
  document: SaleDocument;
  /** True when there was no open bill and this is the person's last bill again (a second Enter): don't print it. */
  repeated: boolean;
}

export interface DocumentSummary {
  id: string;
  number: string;
  createdAt: string;
  total: Money;
  cashDue: Money;
}

export interface Reprint {
  id: string;
  documentId: string;
  number: string;
  userId: string;
  at: string;
  pushedAt: string | null;
}

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-06): ${args.length} arguments`);
};

/** What paying and printing need, from the pulled tenant, methods, profiles and device; null before the first pull. */
export const checkoutSettings = (db: SqlDb): CheckoutSettings | null => notBuilt(db);

/**
 * Finalizes the person's open bill in one transaction (POS spec §12): takes the next `S` number, writes the document
 * and its outbox row, deletes the open bill. Any error rolls all of it back.
 */
export const finalizeSale = (db: SqlDb, req: FinalizeRequest): Finalized => notBuilt(db, req);

/** Stores the device's signature on the document's outbox row (after the commit). */
export const setSignature = (db: SqlDb, documentId: string, signature: string): void =>
  notBuilt(db, documentId, signature);

/** This counter's bills since `since` (ISO), newest first; `text` filters by number. */
export const recentDocuments = (db: SqlDb, since: string, text = ''): DocumentSummary[] =>
  notBuilt(db, since, text);

export const loadDocument = (db: SqlDb, id: string): SaleDocument | null => notBuilt(db, id);

/** Keeps a reprint for the audit log (pushed with W1-07) and the diagnostic log. */
export const recordReprint = (db: SqlDb, r: Omit<Reprint, 'id' | 'pushedAt'>): Reprint => notBuilt(db, r);

export const listReprints = (db: SqlDb): Reprint[] => notBuilt(db);
