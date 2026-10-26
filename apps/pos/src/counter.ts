import type { CounterPinChangeRequest } from '@erp/contracts';
import type { PinState } from '@erp/domain';

import type { DeviceInfo, TenantSettings } from './db/repo';
import type { EnrollResult } from './device/session';
import type { SearchOptions, SearchResult } from './search/search-index';
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
  pull(): Promise<PullResult>;
  staff(): Promise<StaffUser[]>;
  settings(): Promise<TenantSettings | null>;
  getPinState(userId: string): Promise<PinState>;
  setPinState(userId: string, state: PinState): Promise<void>;
  verifyPin(verifier: string, pin: string): Promise<boolean>;
  changePin(body: CounterPinChangeRequest): Promise<PinChangeResult>;
  status(): Promise<{ outboxCount: number; lastSyncAt: string | null }>;
  log(kind: string, detail: Record<string, unknown>): Promise<void>;
  /** Omni-search over the local catalog (POS spec §9). */
  search(text: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** How much of the catalog is on this counter, and whether its first load has finished. */
  catalog(): Promise<{ items: number; ready: boolean }>;
}
