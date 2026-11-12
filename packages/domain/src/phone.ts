// Phone numbers as the counter stores and searches them (POS spec §15, POS-05): a walk-in's phone, a customer's
// phones, and later the bill lookup without a receipt (W1-13). One rule, so typed and imported numbers compare.

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/**
 * The digits of a phone number, with Pakistan's country code written as the trunk 0: `+92 300 1234567`,
 * `0092 300 1234567` and `0300-1234567` are all `03001234567`. Null when it isn't 7 to 15 digits.
 */
export function normalizePhone(text: string): string | null {
  let digits = text.replace(/\D/g, '');
  if (digits.length === 14 && digits.startsWith('0092')) digits = `0${digits.slice(4)}`;
  else if (digits.length === 12 && digits.startsWith('92')) digits = `0${digits.slice(2)}`;
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? digits : null;
}
