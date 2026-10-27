// Money for people (CLAUDE.md rules 1 and 10): whole minor units in, the tenant's locale and currency out. Whole
// amounts show no decimals (Delux bills are whole rupees, D-056); anything else shows every minor digit, never
// rounded away. No float arithmetic: Intl gets the amount as an exact decimal string.

export interface MoneyFormat {
  locale: string;
  currency: string;
  minorUnits: number;
}

const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(minor: number, f: MoneyFormat): string {
  const { decimal, digits } = exactDecimal(minor, f.minorUnits);
  const key = `${f.locale}|${f.currency}|${digits}`;
  let nf = formatters.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(f.locale, {
      style: 'currency',
      currency: f.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, nf);
  }
  return nf.format(decimal as Intl.StringNumericLiteral);
}

/**
 * Whole minor units as plain text for a field to edit: 125000 → "1250", 125050 → "1250.50" with 2 minor units. No
 * symbol and no grouping, with a dot: what parseMoney reads back. Exact, like formatMoney.
 */
export const plainAmount = (minor: number, minorUnits: number): string =>
  exactDecimal(minor, minorUnits).decimal;

/** The exact decimal text of whole minor units, built from integers; whole amounts get no decimals. */
function exactDecimal(minor: number, minorUnits: number): { decimal: string; digits: number } {
  if (!Number.isSafeInteger(minor)) throw new Error(`not whole minor units: ${minor}`);
  const scale = 10 ** minorUnits;
  const abs = Math.abs(minor);
  const fraction = abs % scale;
  const digits = fraction === 0 ? 0 : minorUnits;
  const decimal = `${minor < 0 ? '-' : ''}${(abs - fraction) / scale}${
    digits ? `.${String(fraction).padStart(digits, '0')}` : ''
  }`;
  return { decimal, digits };
}
