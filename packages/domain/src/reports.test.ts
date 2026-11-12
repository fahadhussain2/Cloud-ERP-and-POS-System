import { describe, expect, it } from 'vitest';

import ageingCases from '../golden/ageing.json';
import registerCases from '../golden/register-totals.json';
import { ageBalances, registerTotals, type AgeingInput, type RegisterBill } from './reports';
import { runGolden, type GoldenFile } from './testing/golden';

// The reports' shared arithmetic (W1-20, RPT-01, RPT-06, D-110): the sales register's totals and the ageing buckets,
// used by the API and its CSV alike.

runGolden(registerCases as unknown as GoldenFile<{ bills: RegisterBill[] }>, (i) => registerTotals(i.bills));
runGolden(ageingCases as unknown as GoldenFile<AgeingInput>, ageBalances);

describe('the ageing buckets', () => {
  it('always add up to the balance, whatever the entries', () => {
    const entries = [
      { partyId: 'p', entryDate: '2027-01-01', dueDate: '2027-01-10', amount: 12345 },
      { partyId: 'p', entryDate: '2027-02-01', dueDate: '2027-02-20', amount: 6789 },
      { partyId: 'p', entryDate: '2027-02-05', dueDate: '2027-02-05', amount: -10000 },
      { partyId: 'p', entryDate: '2027-03-01', dueDate: '2027-04-30', amount: 5000 },
    ];
    const [r] = ageBalances({ asOf: '2027-03-31', entries }).rows;
    expect(r!.notDue + r!.days1to30 + r!.days31to60 + r!.days61to90 + r!.over90).toBe(r!.balance);
    expect(r!.balance).toBe(14134);
  });

  it('refuses a date that is not a calendar date, or not a date at all', () => {
    expect(() => ageBalances({ asOf: '2027-02-30', entries: [] })).toThrow();
    expect(() => ageBalances({ asOf: 'tomorrow', entries: [] })).toThrow();
  });

  it('settles two debits due the same day by the older entry first, and lists parties by id', () => {
    const { rows } = ageBalances({
      asOf: '2027-03-31',
      entries: [
        { partyId: 'z', entryDate: '2027-01-20', dueDate: '2027-03-01', amount: 100 },
        { partyId: 'z', entryDate: '2027-01-10', dueDate: '2027-03-01', amount: 100 },
        { partyId: 'z', entryDate: '2027-03-05', dueDate: '2027-03-05', amount: -150 },
        { partyId: 'a', entryDate: '2027-03-30', dueDate: '2027-04-30', amount: 10 },
        { partyId: 'm', entryDate: '2027-03-30', dueDate: '2027-04-30', amount: 20 },
        { partyId: 'b', entryDate: '2027-03-30', dueDate: '2027-04-30', amount: 30 },
      ],
    });
    expect(rows.map((r) => [r.partyId, r.balance, r.days1to30])).toEqual([
      ['a', 10, 0],
      ['b', 30, 0],
      ['m', 20, 0],
      ['z', 50, 50],
    ]);
  });
});

describe('the register totals', () => {
  it('keeps two salesmen with the same name apart, in a fixed order', () => {
    const bill = (id: string, name: string, total: number) => ({
      number: `S-${id}`,
      status: 'finalized' as const,
      kind: 'sale' as const,
      salespersonId: id,
      salespersonName: name,
      deviceCode: id === 'u3' ? 'C2' : 'C1',
      total,
      payments: [{ methodCode: id === 'u3' ? 'card' : 'cash', methodName: 'x', amount: total }],
    });
    const t = registerTotals([bill('u3', 'Zara', 3), bill('u1', 'Ali', 1), bill('u2', 'Ali', 2)]);
    expect(t.bySalesperson.map((p) => [p.id, p.total])).toEqual([
      ['u1', 1],
      ['u2', 2],
      ['u3', 3],
    ]);
    expect(t.byCounter.map((c) => c.code)).toEqual(['C1', 'C2']);
    expect(t.byTender.map((c) => c.code)).toEqual(['card', 'cash']);
  });
});
