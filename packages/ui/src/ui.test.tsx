import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  formatMoney,
  KeyBar,
  matchKey,
  moveSelection,
  OptionList,
  PageHeader,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextField,
  useShortcuts,
} from './index';

// The building blocks every screen uses (W1-03, D-066): keyboard first (POS-03), with the mouse as a second way.

afterEach(cleanup);

const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(window, { key, ...mods });

describe('shortcuts', () => {
  const e = (
    key: string,
    mods: Partial<Record<'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey', boolean>> = {},
  ) => ({
    key,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it('match a key with exactly its modifiers', () => {
    expect(matchKey(e('F2'), 'F2')).toBe(true);
    expect(matchKey(e('l', { altKey: true }), 'Alt+L')).toBe(true);
    expect(matchKey(e('F9', { shiftKey: true }), 'F9')).toBe(false);
    expect(matchKey(e('F9', { shiftKey: true }), 'Shift+F9')).toBe(true);
    expect(matchKey(e('l'), 'Alt+L')).toBe(false);
    expect(() => matchKey(e('x'), 'Hyper+X')).toThrow('unknown modifier');
  });

  it("run the action, stop the browser's own, and stay quiet while disabled", () => {
    const run = vi.fn();
    function Screen({ enabled }: { enabled: boolean }) {
      useShortcuts({ F2: run }, enabled);
      return null;
    }
    const { rerender } = render(<Screen enabled />);
    const event = new KeyboardEvent('keydown', { key: 'F2', cancelable: true });
    window.dispatchEvent(event);
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    press('F3');
    expect(run).toHaveBeenCalledTimes(1);
    rerender(<Screen enabled={false} />);
    press('F2');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('the key bar', () => {
  it('shows each key with its label, and a click does what the key does', () => {
    const lock = vi.fn();
    render(<KeyBar title="Counter" hints={[{ keys: 'Alt+L', label: 'Lock', run: lock }]} />);
    const button = screen.getByRole('button', { name: /Lock/ });
    expect(button.querySelector('kbd')?.textContent).toBe('Alt+L');
    fireEvent.click(button);
    expect(lock).toHaveBeenCalledTimes(1);
  });
});

describe('the option list', () => {
  it('moves with the arrow keys and pages, and stays inside the list', () => {
    expect(moveSelection(0, 'ArrowDown', 3)).toBe(1);
    expect(moveSelection(2, 'ArrowDown', 3)).toBe(2);
    expect(moveSelection(0, 'ArrowUp', 3)).toBe(0);
    expect(moveSelection(1, 'PageDown', 30)).toBe(11);
    expect(moveSelection(25, 'PageDown', 30)).toBe(29);
    expect(moveSelection(5, 'PageUp', 30)).toBe(0);
    expect(moveSelection(0, 'Enter', 3)).toBeNull();
    expect(moveSelection(0, 'ArrowDown', 0)).toBeNull();
  });

  it('shows the selection and reports a click and a double click', () => {
    const chosen = vi.fn();
    function List() {
      const [selected, setSelected] = useState(0);
      return (
        <OptionList
          id="r"
          label="Results"
          items={['A', 'B']}
          selected={selected}
          itemKey={(x) => x}
          onSelect={setSelected}
          onChoose={chosen}
        >
          {(x) => <span>{x}</span>}
        </OptionList>
      );
    }
    render(<List />);
    const [a, b] = screen.getAllByRole('option');
    expect(a!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(b!);
    expect(b!.getAttribute('aria-selected')).toBe('true');
    expect(a!.getAttribute('aria-selected')).toBe('false');
    fireEvent.doubleClick(b!);
    expect(chosen).toHaveBeenCalledWith(1);
  });
});

describe('the dialog', () => {
  it('closes on Esc and gives focus back; the main button runs its action', async () => {
    const save = vi.fn();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Override price</DialogTitle>
          </DialogHeader>
          <p>Body</p>
          <DialogActions cancelLabel="Cancel" actionLabel="Approve" onAction={save} />
        </DialogContent>
      </Dialog>,
    );
    const open = screen.getByRole('button', { name: 'Open' });
    open.focus();
    fireEvent.click(open);
    expect(await screen.findByRole('dialog', { name: 'Override price' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));
  });
});

describe('a field', () => {
  it('ties its label, and its error, to the input', () => {
    render(<TextField label="PIN" error="Wrong PIN" />);
    const input = screen.getByLabelText('PIN');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });
});

describe('money', () => {
  const delux = { locale: 'en-PK', currency: 'PKR', minorUnits: 2 };

  // Intl puts a no-break space between the symbol and the amount.
  const plain = (s: string) => s.replace(/\u00a0/g, ' ');

  it('shows whole rupees without decimals, and never rounds paisa away', () => {
    expect(plain(formatMoney(125000, delux))).toBe('Rs 1,250');
    expect(plain(formatMoney(125050, delux))).toBe('Rs 1,250.50');
    expect(plain(formatMoney(0, delux))).toBe('Rs 0');
    expect(plain(formatMoney(-5000, delux))).toBe('-Rs 50');
    expect(plain(formatMoney(-5, delux))).toBe('-Rs 0.05');
    expect(plain(formatMoney(9007199254740991, delux))).toBe('Rs 90,071,992,547,409.91');
    expect(() => formatMoney(1.5, delux)).toThrow('not whole minor units');
  });
});

// W1-04: the back office's blocks.
describe('back-office blocks', () => {
  it('a checkbox has its label as its name and toggles on click', () => {
    function Box() {
      const [on, setOn] = useState(false);
      return (
        <label>
          <Checkbox checked={on} onCheckedChange={(v) => setOn(v === true)} /> Salesman
        </label>
      );
    }
    render(<Box />);
    const box = screen.getByRole('checkbox', { name: 'Salesman' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(box.getAttribute('aria-checked')).toBe('true');
  });

  it('a status chip carries its tone', () => {
    render(<StatusChip tone="bad">Locked</StatusChip>);
    const chip = screen.getByText('Locked');
    expect(chip.getAttribute('data-tone')).toBe('bad');
    expect(chip.className).toContain('text-bad');
  });

  it('the page header shows the title as the page heading, its help and actions', () => {
    render(<PageHeader title="Staff" help="Everyone in the shop" actions={<Button>Add person</Button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Staff' })).toBeDefined();
    expect(screen.getByText('Everyone in the shop')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add person' })).toBeDefined();
  });

  it('table headers align to the start side, for right-to-left (rule 10)', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Asif</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const head = screen.getByRole('columnheader', { name: 'Name' });
    expect(head.className).toContain('text-start');
    expect(head.className).not.toContain('text-left');
  });
});
