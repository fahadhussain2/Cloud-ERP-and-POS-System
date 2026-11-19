import type { ShopTodayView } from '@erp/contracts';
import { useEffect, useState } from 'react';

import type { Api } from './api';

// The shop's business date (W2-05, D-117): the tenant's time zone and day cut-off (04:00 at Delux), worked out by the
// API, so a back-office screen opened at 00:30 starts on the same day as that night's counter bills. Never this
// browser's calendar, which is a day ahead after midnight (and anywhere outside the shop's time zone).

/** `day` (YYYY-MM-DD) moved by `days` on the calendar; a pure date, no time zone. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The shop's business date from the API, read when the screen opens; null until it is known. */
export function useShopToday(api: Api): string | null {
  const [today, setToday] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/shop/today').then((r) => {
      if (live && r.status === 200) setToday((r.body as ShopTodayView).today);
    });
    return () => {
      live = false;
    };
  }, [api]);
  return today;
}
