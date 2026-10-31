import { money } from '@erp/domain';
import { describe, expect, it } from 'vitest';

import type { CounterCustomer } from '../db/customers';
import { maskPhone, searchCustomers } from './customer-search';

// Finding a customer on the counter (POS spec §15): code, phone digits, name and city words.

const customer = (code: string, name: string, phones: string[], city: string | null = 'Karachi') =>
  ({
    id: `id-${code}`,
    code,
    name,
    phones,
    city,
    account: { tierId: 't', creditAllowed: true, creditLimit: null, offlineDailyCap: money(2500000) },
    balance: money(0),
  }) satisfies CounterCustomer;

const LIST = [
  customer('C0042', 'Khan Motors', ['0300-1234567', '021-34567890']),
  customer('C0043', 'Ali Autos', ['0333 7654321'], 'Lahore'),
  customer('C1042', 'Bilal Khan Spares', []),
  customer('C0420', 'Moto Hub', ['+92 345 1112222']),
];
const codes = (text: string) => searchCustomers(LIST, text).map((c) => c.code);

describe('searchCustomers', () => {
  it('finds nothing for empty text', () => {
    expect(codes('  ')).toEqual([]);
  });

  it('puts the exact code first, then codes that start with the text', () => {
    expect(codes('c0042')).toEqual(['C0042']);
    expect(codes('C004')).toEqual(['C0043', 'C0042']);
  });

  it('finds 4 or more digits anywhere in a phone, however it was typed or stored', () => {
    expect(codes('4567')).toEqual(['C0042']);
    expect(codes('0300 123')).toEqual(['C0042']);
    expect(codes('+92 300 1234567')).toEqual(['C0042']);
    expect(codes('03451112222')).toEqual(['C0420']);
    expect(codes('765')).toEqual([]);
  });

  it('matches every word against the starts of the name and city words', () => {
    expect(codes('khan')).toEqual(['C1042', 'C0042']);
    expect(codes('khan mot')).toEqual(['C0042']);
    expect(codes('ali lahore')).toEqual(['C0043']);
    expect(codes('motors lahore')).toEqual([]);
  });
});

describe('maskPhone', () => {
  it('shows only the last four digits (owner answer 4)', () => {
    expect(maskPhone('0300-1234567')).toBe('•••• 4567');
    expect(maskPhone('123')).toBe('••••');
  });
});
