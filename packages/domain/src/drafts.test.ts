import { describe, expect, it } from 'vitest';

import { isEmptyDraft } from './drafts';

// A draft with nothing typed in it is refused (owner's review of W1-19): it can't post, and it only clutters the
// lists and the lock checklist. A line counts once it has an item, an account or an amount.

describe('an empty draft', () => {
  it('has no line with an item, an account or an amount', () => {
    expect(isEmptyDraft([])).toBe(true);
    expect(
      isEmptyDraft([
        { accountId: null, debit: 0, credit: 0 },
        { accountId: null, debit: 0, credit: 0 },
      ]),
    ).toBe(true);
    expect(isEmptyDraft([{ itemId: null, qty: 0 }])).toBe(true);
  });

  it('is not empty once a line has an item, an account or an amount', () => {
    expect(isEmptyDraft([{ itemId: 'i1', qty: 0 }])).toBe(false);
    expect(isEmptyDraft([{ accountId: 'a1', debit: 0, credit: 0 }])).toBe(false);
    expect(isEmptyDraft([{ accountId: null, debit: 150000, credit: 0 }])).toBe(false);
    expect(isEmptyDraft([{ accountId: null, debit: 0, credit: 150000 }])).toBe(false);
  });
});
