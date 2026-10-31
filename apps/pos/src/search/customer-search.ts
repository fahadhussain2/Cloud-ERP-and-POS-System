import { normalizePhone } from '@erp/domain';

import type { CounterCustomer } from '../db/customers';

// Finding a customer on the counter (POS spec §15, POS-05): by code, by 4 or more digits of a phone, or by words of the
// name or city. A handful of customers per shop (Delux: 131), so a plain scan over the pulled list is fast enough.

export const MAX_CUSTOMER_RESULTS = 50;

const words = (text: string) =>
  text
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const digits = (text: string) => text.replace(/\D/g, '');

/** How well a customer matches: 0 code exact, 1 code start, 2 phone, 3 name or city words; null = no match. */
function rank(c: CounterCustomer, text: string): number | null {
  const upper = text.trim().toUpperCase();
  const code = c.code.toUpperCase();
  if (code === upper) return 0;
  if (upper.length >= 2 && code.startsWith(upper)) return 1;
  const typed = digits(text);
  // A phone search is mostly digits: "0300 123", "+92 300", "4567".
  if (typed.length >= 4 && typed.length >= text.replace(/\s/g, '').length - 1) {
    const wanted = [typed, normalizePhone(text)].filter((x): x is string => x !== null && x.length >= 4);
    const phones = c.phones.flatMap((p) => [digits(p), normalizePhone(p) ?? '']);
    if (phones.some((p) => wanted.some((w) => p.includes(w)))) return 2;
  }
  const typedWords = words(text);
  const own = [...words(c.name), ...words(c.city ?? '')];
  if (typedWords.length > 0 && typedWords.every((w) => own.some((o) => o.startsWith(w)))) return 3;
  return null;
}

/** The customers matching `text`, best first, then by name; at most 50. Empty text: none. */
export function searchCustomers(customers: readonly CounterCustomer[], text: string): CounterCustomer[] {
  if (text.trim() === '') return [];
  return customers
    .flatMap((c) => {
      const r = rank(c, text);
      return r === null ? [] : [{ c, r }];
    })
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name) || a.c.code.localeCompare(b.c.code))
    .slice(0, MAX_CUSTOMER_RESULTS)
    .map((x) => x.c);
}

/** A phone as the counter screen shows it: only the last four digits (owner answer 4 to W1-09). */
export const maskPhone = (phone: string): string => {
  const d = digits(phone);
  return d.length <= 4 ? '••••' : `•••• ${d.slice(-4)}`;
};
