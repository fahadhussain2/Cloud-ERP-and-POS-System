import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Plus, Save } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../i18n';
import en from '../locales/en.json';
import {
  ActionBar,
  Button,
  buttonClass,
  Checkbox,
  ConfirmDialog,
  FIELD_BOX,
  FormDialog,
  IconButton,
  ListToolbar,
  notify,
  SearchBox,
  Select,
  TextInput,
  Toaster,
} from './index';

// The back office's own controls (W2-12 plan, "Back-office kit"): composed from packages/ui, never editing it, so the
// POS keeps its look. These tests pin what the screens rely on: names for screen readers, the keyboard, where
// problems show (answer 6), the dialog's parts and its focus (D-053).

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const show = (ui: ReactElement) => render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);

describe('Button', () => {
  it('puts its icon before the word, hidden from screen readers, so its name is the word', () => {
    show(<Button icon={Plus}>Add customer</Button>);
    const button = screen.getByRole('button', { name: 'Add customer' });
    const icon = button.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(button.firstElementChild).toBe(icon);
  });

  it('has no fill when quiet (ghost, link), only the primary is orange', () => {
    show(
      <>
        <Button>Save</Button>
        <Button variant="ghost">Add a brand</Button>
        <Button variant="link">More</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('bg-primary');
    for (const name of ['Add a brand', 'More'])
      expect(screen.getByRole('button', { name }).className).not.toContain('bg-primary');
  });

  it('gives a link that looks like a button the same layout: its icon beside the word', () => {
    const cls = buttonClass('outline');
    for (const c of ['inline-flex', 'items-center', 'whitespace-nowrap', 'h-9']) expect(cls).toContain(c);
  });

  it('is 36px tall, or 32px when small', () => {
    show(
      <>
        <Button>Save</Button>
        <Button size="sm">Show</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('h-9');
    expect(screen.getByRole('button', { name: 'Show' }).className).toContain('h-8');
  });
});

describe('IconButton', () => {
  it('is named by its label and shows it as a tooltip on focus', async () => {
    show(<IconButton icon={Save} label="Edit Khan Motors" />);
    const button = screen.getByRole('button', { name: 'Edit Khan Motors' });
    expect(button.textContent).toBe('');
    act(() => {
      button.focus();
    });
    expect(await screen.findByRole('tooltip')).toHaveProperty('textContent', 'Edit Khan Motors');
    // It never takes a click meant for what is under it (a row's icon above).
    expect(document.querySelector('[data-slot="tooltip-content"]')?.className).toContain(
      'pointer-events-none',
    );
  });
});

describe('TextInput', () => {
  it('wires the label above, the hint, and the error that replaces it', () => {
    const { rerender } = show(<TextInput label="Name" hint="As on the bill" />);
    const input = screen.getByLabelText('Name');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText('As on the bill')).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('As on the bill').id);

    rerender(
      <I18nextProvider i18n={i18n}>
        <TextInput label="Name" hint="As on the bill" error="Enter a name" />
      </I18nextProvider>,
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('As on the bill')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('Enter a name').id);
  });

  it('is 36px tall with a sentence-case label', () => {
    show(<TextInput label="Phone" />);
    expect(screen.getByLabelText('Phone').className).toContain('h-9');
    expect(screen.getByText('Phone').className).not.toContain('uppercase');
  });
});

describe('Select', () => {
  const OPTIONS = [
    { value: 'active', label: 'Active' },
    { value: 'inactive', label: 'Inactive' },
    { value: 'all', label: 'All' },
  ];
  function Picker({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState('active');
    return (
      <Select
        label="Show"
        value={value}
        options={OPTIONS}
        onValueChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    );
  }

  it('is a combobox named by its label, showing the chosen option', () => {
    show(<Picker onChange={() => undefined} />);
    const box = screen.getByRole('combobox', { name: 'Show' });
    expect(box.textContent).toContain('Active');
  });

  it('opens with ↓, moves with ↓, picks with Enter and reports the value', async () => {
    const onChange = vi.fn();
    show(<Picker onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Show' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox');
    const active = within(list).getByRole('option', { name: 'Active' });
    expect(active.getAttribute('aria-selected')).toBe('true');
    // Radix moves the highlight on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(active));
    fireEvent.keyDown(active, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Inactive'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('inactive');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box.textContent).toContain('Inactive');
  });

  it('closes on Esc without changing the value', async () => {
    const onChange = vi.fn();
    show(<Picker onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Show' });
    fireEvent.keyDown(box, { key: 'Enter' });
    const list = await screen.findByRole('listbox');
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// Bug (owner's review of New goods receipt, 2026-11-28; W2-16 point 3): the item list always opened under its field and
// ran past the bottom of the window when the field was near it.
describe('SearchBox near the bottom of the window', () => {
  const HITS = ['AFLT001', 'AFLT002', 'AFLT003'];
  /** The box with its field's edges at `top`–`top + 36` in a 768px window; the list it draws over the page. */
  const listAt = (top: number) => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(768);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 36,
      left: 20,
      right: 320,
      width: 300,
      height: 36,
      x: 20,
      y: top,
      toJSON: () => ({}),
    });
    show(
      <SearchBox
        floating="page"
        label="Item of line 4"
        listLabel="Items found"
        text="a"
        onText={() => undefined}
        hits={HITS}
        hitKey={(h) => h}
        onPick={() => undefined}
        onEscape={() => undefined}
      >
        {(h) => h}
      </SearchBox>,
    );
    return screen.getByRole('listbox');
  };
  afterEach(() => vi.restoreAllMocks());

  it('opens above its field when there is no room under it', () => {
    // The field ends 100px above the window's bottom.
    const list = listAt(632);
    expect(list.style.top).toBe('');
    expect(list.style.bottom).toBe(`${768 - 632 + 4}px`);
  });

  it('stays under its field when there is some room, no taller than that room', () => {
    // The field ends 180px above the window's bottom.
    const list = listAt(552);
    expect(list.style.top).toBe(`${552 + 36 + 4}px`);
    expect(parseFloat(list.style.maxHeight)).toBeLessThanOrEqual(180 - 4);
  });

  it('opens under its field, at its full height, when there is room', () => {
    const list = listAt(200);
    expect(list.style.top).toBe(`${200 + 36 + 4}px`);
    expect(list.style.maxHeight).toBe('256px');
  });
});

describe('Checkbox', () => {
  it('is named by its label and toggles', () => {
    const onChange = vi.fn();
    show(<Checkbox label="Credit allowed" checked={false} onCheckedChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Credit allowed' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('FormDialog', () => {
  function Form({
    onSubmit,
    errors = {},
  }: {
    onSubmit: () => void;
    errors?: Record<string, string | undefined>;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Add customer</Button>
        <FormDialog
          open={open}
          onOpenChange={setOpen}
          title="Add customer"
          actionLabel="Save"
          actionIcon={Save}
          busy={false}
          onSubmit={onSubmit}
          errors={errors}
        >
          <TextInput label="Code" />
          <TextInput label="Name" error={errors['name']} />
          <TextInput label="Credit limit" error={errors['limit']} />
        </FormDialog>
      </>
    );
  }

  it('has a header, a body that scrolls, and a footer with Cancel then the main button, each with its icon', () => {
    show(<Form onSubmit={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    const dialog = screen.getByRole('dialog', { name: 'Add customer' });
    const body = dialog.querySelector('[data-slot="dialog-body"]');
    expect(body?.className).toContain('overflow-y-auto');
    expect(body?.contains(screen.getByLabelText('Name'))).toBe(true);
    const footer = dialog.querySelector('[data-slot="dialog-footer"]');
    const buttons = within(footer as HTMLElement).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([en.app.cancel, 'Save']);
    for (const b of buttons) expect(b.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    // No visible key hints in the back office (answer 1); the shortcuts stay for screen readers.
    expect(buttons[0]?.getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(buttons[1]?.getAttribute('aria-keyshortcuts')).toBe('Enter');
    expect(dialog.textContent).not.toContain('Esc');
  });

  it('submits on Enter, closes on Esc and gives focus back to the opener', async () => {
    const onSubmit = vi.fn();
    show(<Form onSubmit={onSubmit} />);
    const opener = screen.getByRole('button', { name: 'Add customer' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.submit(screen.getByLabelText('Name').closest('form') as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Radix gives focus back on the next tick.
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('with problems, marks every wrong field and puts focus on the first', () => {
    const { rerender } = show(<Form onSubmit={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    fireEvent.submit(screen.getByLabelText('Name').closest('form') as HTMLFormElement);
    rerender(
      <I18nextProvider i18n={i18n}>
        <Form onSubmit={() => undefined} errors={{ name: 'Enter a name', limit: 'Enter a credit limit' }} />
      </I18nextProvider>,
    );
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Credit limit').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });
});

describe('ConfirmDialog', () => {
  it('asks, with Cancel and a red main button', () => {
    const onConfirm = vi.fn();
    show(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Delete Khan Motors?"
        actionLabel="Delete"
        tone="danger"
        busy={false}
        onConfirm={onConfirm}
      >
        It has no bills and no balance.
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete Khan Motors?' });
    expect(dialog.textContent).toContain('It has no bills and no balance.');
    const del = within(dialog).getByRole('button', { name: 'Delete' });
    expect(del.className).toContain('bg-bad');
    fireEvent.click(del);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('ListToolbar', () => {
  it('holds the search, the filters and the count', () => {
    const onSearch = vi.fn();
    show(
      <ListToolbar search={{ label: 'Search customers', value: '', onChange: onSearch }} count="6 customers">
        <span>filters</span>
      </ListToolbar>,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search customers' }), {
      target: { value: 'khan' },
    });
    expect(onSearch).toHaveBeenCalledWith('khan');
    expect(screen.getByText('filters')).toBeTruthy();
    expect(screen.getByText('6 customers')).toBeTruthy();
  });
});

describe('notify', () => {
  it('shows a result as a status that fades, and a problem as an alert that stays until closed', () => {
    vi.useFakeTimers();
    show(<Toaster />);
    act(() => {
      notify.done('Khan Motors saved.');
    });
    expect(screen.getByRole('status').textContent).toContain('Khan Motors saved.');
    act(() => {
      notify.problem('No connection. Your entries are kept.');
    });
    expect(screen.getByRole('alert').textContent).toContain('No connection.');

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByRole('status')).toBeNull();
    const alert = screen.getByRole('alert');
    fireEvent.click(within(alert).getByRole('button', { name: en.app.close }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// W2-16 (the goods receipt layout, owner 2026-11-28): a bar kept at the bottom of the window, a red bin on a line, a
// note under a dropdown's options, and the faint fill dark-mode fields keep.
describe('ActionBar', () => {
  it('is a named region kept at the bottom of the window', () => {
    show(
      <ActionBar label="Save or post">
        <Button>Post</Button>
      </ActionBar>,
    );
    const bar = screen.getByRole('region', { name: 'Save or post' });
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('bottom-0');
    expect(within(bar).getByRole('button', { name: 'Post' })).toBeDefined();
  });
});

describe('IconButton, red', () => {
  it('is red at rest with tone="bad", grey with tone="danger"', () => {
    show(
      <>
        <IconButton icon={Save} tone="bad" label="Remove line 1" />
        <IconButton icon={Save} tone="danger" label="Delete Khan Motors" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Remove line 1' }).className).toContain('text-bad');
    expect(screen.getByRole('button', { name: 'Delete Khan Motors' }).className).not.toMatch(
      /(^|\s)text-bad(\s|$)/,
    );
  });
});

describe('Select with a note', () => {
  it('shows the note under the options, not as an option', async () => {
    show(
      <Select
        label="Paid"
        value="account"
        onValueChange={() => undefined}
        options={[{ value: 'account', label: "On the supplier's account" }]}
        note="Paid in cash? Pay it at the desk."
      />,
    );
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Paid' }), { key: 'ArrowDown' });
    const list = await screen.findByRole('listbox');
    expect(within(list).getByText('Paid in cash? Pay it at the desk.')).toBeDefined();
    expect(within(list).getAllByRole('option')).toHaveLength(1);
  });
});

describe('fields in dark mode', () => {
  it('keep a faint fill of their own, on boxes and on the controls drawn as a field', () => {
    expect(FIELD_BOX).toContain('dark:bg-input/30');
  });
});
