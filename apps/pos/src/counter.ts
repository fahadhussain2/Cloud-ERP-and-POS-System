import type { CounterPinChangeRequest } from '@erp/contracts';
import type { Money, PinState, RoleGrant } from '@erp/domain';

import type { OpenBill } from './bill/open-bill';
import type { DeviceInfo, PinEvent, TenantSettings } from './db/repo';
import type { EnrollResult } from './device/session';
import type { BillItem, SearchOptions, SearchResult, Tier } from './search/search-index';
import type { CheckResult } from './storage/checks';
import type { PinChangeResult } from './sync/pin';
import type { PullResult } from './sync/pull';
import type { StaffUser } from './unlock/unlock';

// Everything the counter screens need from the PC and the server, in one place, so the screens can be tested with a
// fake. The real one is browserCounter() (counter-browser.ts).

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
  status(): Promise<{ outboxCount: number; lastSyncAt: string | null }>;
  log(kind: string, detail: Record<string, unknown>): Promise<void>;
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
}
