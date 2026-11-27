import { fireEvent, screen, waitFor, within } from '@testing-library/react';

// For component tests: picks an option in a kit Select (W2-12), which is a button and a list (Radix), not a native
// <select>, so `fireEvent.change` no longer works. `scope` limits the search for the box, e.g. to a dialog.

export async function chooseOption(
  label: string | RegExp,
  option: string,
  scope?: HTMLElement,
): Promise<void> {
  const box = (scope ? within(scope) : screen).getByRole('combobox', { name: label });
  fireEvent.keyDown(box, { key: 'Enter' });
  const list = await screen.findByRole('listbox');
  fireEvent.click(within(list).getByRole('option', { name: option }));
  await waitFor(() => {
    if (screen.queryByRole('listbox')) throw new Error('the list is still open');
  });
}

/**
 * Picks the option with `value` in a kit Select, or types it into a searched choice (a ChoiceFilter of more than 15:
 * the hit is taken with Enter). An empty value is a filter's "all" (`__all`).
 */
export async function chooseValue(label: string | RegExp, value: string, scope?: HTMLElement): Promise<void> {
  const box = (scope ? within(scope) : screen).getByRole('combobox', { name: label });
  if (box.tagName === 'INPUT') {
    fireEvent.change(box, { target: { value } });
    fireEvent.keyDown(box, { key: 'Enter' });
    return;
  }
  fireEvent.keyDown(box, { key: 'Enter' });
  const list = await screen.findByRole('listbox');
  const option = list.querySelector(`[role="option"][data-value="${value === '' ? '__all' : value}"]`);
  if (!option) {
    fireEvent.keyDown(list, { key: 'Escape' });
    await waitFor(() => {
      if (screen.queryByRole('listbox')) throw new Error('the list is still open');
    });
    throw new Error(`no option with the value ${value} in ${String(label)}`);
  }
  fireEvent.click(option);
  await waitFor(() => {
    if (screen.queryByRole('listbox')) throw new Error('the list is still open');
  });
}
