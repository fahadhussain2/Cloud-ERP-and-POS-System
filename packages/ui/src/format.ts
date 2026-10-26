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
  if (!Number.isSafeInteger(minor)) throw new Error(`not whole minor units: ${minor}`);
  const scale = 10 ** f.minorUnits;
  const abs = Math.abs(minor);
  const fraction = abs % scale;
  const digits = fraction === 0 ? 0 : f.minorUnits;
  const decimal = `${minor < 0 ? '-' : ''}${(abs - fraction) / scale}${
    digits ? `.${String(fraction).padStart(digits, '0')}` : ''
  }`;
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
