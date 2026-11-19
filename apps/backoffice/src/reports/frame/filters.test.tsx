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
