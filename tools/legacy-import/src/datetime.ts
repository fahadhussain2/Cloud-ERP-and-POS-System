import { DumpError } from './errors';

// SQL Server DateTime (migration doc §1): 4-byte signed days since 1900-01-01, then 4-byte ticks of 1/300 s.

const TICKS_PER_DAY = 24 * 3600 * 300;
const EPOCH_1900 = Date.UTC(1900, 0, 1);
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DD HH:MM:SS.mmm` in UTC (legacy times are local Karachi time, kept as written). */
function format(ms: number): string {
  const d = new Date(ms);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/** The 16 hex digits of `CAST(0x… AS DateTime)` as ISO text, rounded to milliseconds like SQL Server. */
export function binaryDateTime(hex: string): string {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) throw new DumpError('bad_datetime', 'a DateTime must be 8 bytes');
  const days = Number.parseInt(hex.slice(0, 8), 16) | 0; // signed 32-bit
  const ticks = Number.parseInt(hex.slice(8), 16);
  if (ticks >= TICKS_PER_DAY) throw new DumpError('bad_datetime', 'DateTime ticks past the end of the day');
  // round(ticks × 10 / 3) in integers: 1 tick → 3 ms, 2 → 7 ms.
  const ms = Math.floor((ticks * 10 + 1) / 3);
  return format(EPOCH_1900 + days * 86_400_000 + ms);
}

/** `CAST(N'2025-07-01T08:30:00.000' AS DateTime)` → the same ISO text as the binary form. */
export function textDateTime(text: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(text);
  return m ? `${m[1]} ${m[2]}.${(m[3] ?? '').padEnd(3, '0')}` : null;
}
