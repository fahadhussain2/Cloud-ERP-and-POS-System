import type { PartyHit } from '@erp/contracts';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Api } from '../api';
import { i18n } from '../i18n';
import { PartyPicker } from './data';

// Bug (owner, 2026-11-26; W2-13): the customer/supplier search on vouchers and money screens couldn't be used from the
// keyboard: ↓ didn't move through the results and Enter picked nothing.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const hit = (id: string, code: string, name: string): PartyHit => ({
  id,
  code,
  name,
  customer: true,
  supplier: false,
  customerBalance: 0,
  supplierBalance: 0,
});
const THREE = [
  hit('p1', 'C0041', 'Khan Motors'),
  hit('p2', 'C0042', 'Khan Autos'),
  hit('p3', 'C0043', 'Khan Brothers'),
];

async function openWithThree(onPick: (p: PartyHit | null) => void) {
  vi.useFakeTimers();
  const api: Api = () => Promise.resolve({ status: 200, body: THREE });
  render(
    <I18nextProvider i18n={i18n}>
      <PartyPicker api={api} label="Customer" role="customer" picked={null} onPick={onPick} />
    </I18nextProvider>,
  );
  const box = screen.getByRole('combobox', { name: 'Customer' });
  fireEvent.change(box, { target: { value: 'khan' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getAllByRole('option')).toHaveLength(3);
  return box;
}
const highlighted = () =>
  screen.getAllByRole('option').findIndex((o) => o.getAttribute('aria-selected') === 'true');

describe('the customer and supplier search from the keyboard (W2-13)', () => {
  it('starts on the first result; ↓ ↓ Enter picks the third', async () => {
    const onPick = vi.fn();
    const box = await openWithThree(onPick);
    expect(highlighted()).toBe(0);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
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
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1]!.id);
  });

  it('closes on Esc without picking', async () => {
    const onPick = vi.fn();
    const box = await openWithThree(onPick);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
