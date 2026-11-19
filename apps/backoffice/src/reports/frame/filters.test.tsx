import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryOf } from '../../router';
import { useFilters } from './filters';

// A report's filters in its address (W2-01 answer 6), and those never remembered (W2-04 answer 8, D-117).

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

/** A change of filters, and the screen drawn again before the address's change arrives (a report that loaded). */
function Probe() {
  const [filters, set] = useFilters('probe', { forget: ['date'] });
  const [, draw] = useState(0);
  return (
    <button
      type="button"
      onClick={() => {
        set({ side: 'suppliers', date: '2026-11-19' });
        draw((n) => n + 1);
      }}
    >
      {JSON.stringify(filters)}
    </button>
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

  it('keeps a forgotten filter in the address when the screen is drawn again before the address changes', async () => {
    render(<Probe />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(screen.getByRole('button').textContent).toBe('{"side":"suppliers","date":"2026-11-19"}'),
    );
    expect(Object.fromEntries(queryOf(window.location.hash))).toEqual({
      side: 'suppliers',
      date: '2026-11-19',
    });
    // Remembered without it: opened again, the report starts on its default date.
    cleanup();
    window.location.hash = '#/reports/probe';
    render(<Probe />);
    expect(screen.getByRole('button').textContent).toBe('{"side":"suppliers"}');
  });
});
