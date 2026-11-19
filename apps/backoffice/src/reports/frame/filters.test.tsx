import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryOf } from '../../router';
import { useFilters } from './filters';

// A report's filters in its address (W2-01 answer 6).

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '#/reports/probe';
});
afterEach(cleanup);

/** A box drawn from a filter, as the ledger's "As a statement". */
function Box() {
  const [filters, set] = useFilters('probe');
  return (
    <input
      type="checkbox"
      aria-label="As a statement"
      checked={filters['statement'] === '1'}
      onChange={(e) => set({ statement: e.target.checked ? '1' : '' })}
    />
  );
}

describe('useFilters', () => {
  it('shows a changed filter at once, before the address change is announced (hashchange)', () => {
    render(<Box />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'As a statement' });
    fireEvent.click(box);
    // No waiting: a browser announces the new address later, and the box must not look unchanged meanwhile (e2e
    // user-and-partner-reports.spec's check() read it unchanged on Chromium).
    expect(box.checked).toBe(true);
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({ statement: '1' });
  });
});
