// Offline warnings (SYN-06, POS-14, POS spec §7, W1-07): counted from the last successful push or pull, with the
// tenant's thresholds. Selling is never blocked; this only picks the banner.

export type OfflineLevel = 'none' | 'warning' | 'strong';

export interface OfflineThresholds {
  warningHours: number;
  strongHours: number;
}

/** The PRD's examples, used until the tenant sends its own (an older server). */
export const DEFAULT_THRESHOLDS: OfflineThresholds = { warningHours: 8, strongHours: 48 };

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-07): ${args.length} arguments`);
};

/** `none` before the first contact: a counter that never reached the server is still being set up. */
export function offlineLevel(
  lastContactAt: string | null,
  nowMs: number,
  t: OfflineThresholds,
): OfflineLevel {
  return notBuilt(lastContactAt, nowMs, t);
}
