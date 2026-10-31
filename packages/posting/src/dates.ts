// Calendar dates as ISO `YYYY-MM-DD`, with no time zone: business dates are already the tenant's (D-056).

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nothing posts on or before the lock date (posting rules §1.6): a document dated there posts the day after. */
export const entryDateOf = (businessDate: string, lockDate: string | null): string =>
  lockDate !== null && businessDate <= lockDate ? addDays(lockDate, 1) : businessDate;
