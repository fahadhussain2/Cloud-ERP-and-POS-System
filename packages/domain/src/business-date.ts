import { DomainError } from './errors';

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(timeZone: string, instantMs: number) {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      throw new DomainError('invalid_time_zone', `unknown time zone: ${timeZone}`);
    }
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(instantMs).map((p) => [p.type, Number(p.value)]));
  return { year: parts['year']!, month: parts['month']!, day: parts['day']!, hour: parts['hour']! };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * The business date (YYYY-MM-DD) of an instant: the tenant-local date, minus one day while the local hour is
 * before the cutoff (Delux: 04:00), so late sales count to the day they belong to (architecture §4.4, D-056).
 * The instant is passed in (epoch milliseconds); the clock is never read here.
 */
export function businessDate(instantMs: number, timeZone: string, cutoffHour: number): string {
  if (!Number.isSafeInteger(instantMs))
    throw new DomainError('not_integer', `not a valid instant: ${instantMs}`);
  if (!Number.isInteger(cutoffHour) || cutoffHour < 0 || cutoffHour > 23) {
    throw new DomainError('invalid_cutoff', `the cutoff hour must be 0 to 23: ${cutoffHour}`);
  }
  const local = localParts(timeZone, instantMs);
  if (local.hour >= cutoffHour) return `${pad(local.year, 4)}-${pad(local.month)}-${pad(local.day)}`;
  const previous = new Date(Date.UTC(local.year, local.month - 1, local.day - 1));
  return `${pad(previous.getUTCFullYear(), 4)}-${pad(previous.getUTCMonth() + 1)}-${pad(previous.getUTCDate())}`;
}
