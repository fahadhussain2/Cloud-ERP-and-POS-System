import { Table, TableBody, TableCell, TableRow } from '@erp/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import { ItemPicker } from './ItemPicker';

// Bug (owner, staging 2026-11-08): on a line in a table the results were cut off by the table's scrolling container,
// on the goods receipt, purchase return and adjustment screens alike. The list must not be inside that container.
// Bug (owner, 2026-11-26; W2-13): ↓ didn't move through the results, and Enter always took the first one.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the item picker on a table line', () => {
  it('shows its results outside the table, so the table can’t cut them off', async () => {
    vi.useFakeTimers();
    const api: Api = () =>
      Promise.resolve({
        status: 200,
        body: { items: [{ id: 'i1', code: 'AFLT001', name: 'AIR FILTER COROLLA JAPAN' }] },
      });
    render(
      <I18nextProvider i18n={i18n}>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>
                <ItemPicker api={api} label="Item of line 1" picked={null} onPick={() => undefined} />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Item of line 1' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Item of line 1' }), { target: { value: 'a' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const list = screen.getByRole('listbox');
    expect(list.textContent).toContain('AFLT001');
    expect(list.closest('[data-slot="table-container"]')).toBeNull();
  });
});

const THREE = [
  { id: 'i1', code: 'FNBL001', name: 'FAN BELT CULTUS 4PK-855' },
  { id: 'i2', code: 'FNBL002', name: 'FAN BELT MEHRAN' },
  { id: 'i3', code: 'FNBL003', name: 'FAN BELT ALTO' },
];

/** The picker open with three results, as on a goods receipt line. */
async function openWithThree(onPick: (item: { id: string }) => void) {
  vi.useFakeTimers();
  const api: Api = () => Promise.resolve({ status: 200, body: { items: THREE } });
  render(
    <I18nextProvider i18n={i18n}>
      <ItemPicker api={api} label="Item of line 1" picked={null} onPick={onPick} />
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Item of line 1' }));
  const box = screen.getByRole('combobox', { name: 'Item of line 1' });
  fireEvent.change(box, { target: { value: 'fan belt' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getAllByRole('option')).toHaveLength(3);
  return box;
}
const highlighted = () =>
  screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');

describe('the item picker from the keyboard (W2-13)', () => {
  it('starts on the first result; ↓ ↓ Enter picks the third', async () => {
    const onPick = vi.fn();
    const box = await openWithThree(onPick);
    expect(highlighted()).toBe(0);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(highlighted()).toBe(2);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(THREE[2]);
  });

  it('stays on the first with ↑ at the top, and PageDown goes to the last', async () => {
    const box = await openWithThree(() => undefined);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(highlighted()).toBe(0);
    fireEvent.keyDown(box, { key: 'PageDown' });
    expect(highlighted()).toBe(2);
  });

  it('tells screen readers which result is highlighted', async () => {
    const box = await openWithThree(() => undefined);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1]!;
    expect(box.getAttribute('aria-activedescendant')).toBe(second.id);
    expect(box.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on Esc without picking', async () => {
    const onPick = vi.fn();
    const box = await openWithThree(onPick);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
