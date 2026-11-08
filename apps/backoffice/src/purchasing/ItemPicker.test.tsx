import { Table, TableBody, TableCell, TableRow } from '@erp/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import { ItemPicker } from './ItemPicker';

// Bug (owner, staging 2026-11-08): on a line in a table the results were cut off by the table's scrolling container,
// on the goods receipt, purchase return and adjustment screens alike. The list must not be inside that container.

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
    fireEvent.change(screen.getByRole('textbox', { name: 'Item of line 1' }), { target: { value: 'a' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const list = screen.getByRole('listbox');
    expect(list.textContent).toContain('AFLT001');
    expect(list.closest('[data-slot="table-container"]')).toBeNull();
  });
});
