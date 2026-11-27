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
