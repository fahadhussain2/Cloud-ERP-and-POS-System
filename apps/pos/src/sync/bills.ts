import { BillStatusResponseSchema } from '@erp/contracts';
import type { CashDeskStatus } from '@erp/domain';

import type { TokenSource } from '../device/session';
import type { Api } from '../net/api';

// The live check before a void (POS spec §18, W1-12): has the cash desk taken this bill's cash? Asked online only, and
// for at most 3 seconds; anything else (offline, no answer, a refusal, a bill the server doesn't have yet) is
// `unknown`, and the void goes on with a warning while the server flags it if the cash was taken (D-059).

export interface DeskCheck {
  status: CashDeskStatus;
  /** When and by whom, for a bill already handed over. */
  at: string | null;
  cashierName: string | null;
}

export const UNKNOWN: DeskCheck = { status: 'unknown', at: null, cashierName: null };
const TIMEOUT_MS = 3000;

export async function checkDesk(
  deps: { api: Api; tokens: TokenSource },
  billNumber: string,
  timeoutMs = TIMEOUT_MS,
): Promise<DeskCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DeskCheck>((resolve) => {
    timer = setTimeout(() => resolve(UNKNOWN), timeoutMs);
  });
  const ask = (async (): Promise<DeskCheck> => {
    try {
      const res = await deps.api('GET', `/api/sync/bills/status?number=${encodeURIComponent(billNumber)}`, {
        token: await deps.tokens.get(),
      });
      if (res.status === 401) deps.tokens.invalidate();
      const parsed = BillStatusResponseSchema.safeParse(res.body);
      if (res.status !== 200 || !parsed.success) return UNKNOWN;
      const b = parsed.data;
      // A bill the server hasn't got, with no scan of it either: an offline desk may still hold a scan.
      if (b.handoverStatus === null) return UNKNOWN;
      return { status: b.handoverStatus, at: b.handedOverAt, cashierName: b.cashierName };
    } catch {
      return UNKNOWN;
    }
  })();
  try {
    return await Promise.race([ask, late]);
  } finally {
    clearTimeout(timer);
  }
}
