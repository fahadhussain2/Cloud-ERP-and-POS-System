import { cn } from '@erp/ui';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from 'react';

import { TextBox } from '../ui';

// A document's fields, one problem under each (W2-16, owner's review of New goods receipt 2026-11-28; answer 6 of
// W2-12): the check's problems mapped to the field they are about, shown once that field is left or when Save draft
// or Post is pressed, never while it is still being typed in. Used by goods receipts and purchase returns.

/** The header field each problem of a receipt's or a return's check is about. */
export const HEAD_FIELD: Readonly<Record<string, string>> = {
  supplier_required: 'supplier',
  bill_no_required: 'billNo',
  bill_date_required: 'billDate',
  location_required: 'location',
  bill_discount_invalid: 'billDiscount',
  total_required: 'billTotal',
  total_mismatch: 'billTotal',
  lines_required: 'lines',
  reason_required: 'reason',
  reason_unknown: 'reason',
  note_required: 'note',
};

export type LineField = 'item' | 'qty' | 'unitCost' | 'discount';

/** The line field each problem of a line is about; any other goes under the item. */
const LINE_FIELD: Readonly<Record<string, LineField>> = {
  item_required: 'item',
  qty_positive: 'qty',
  qty_fraction: 'qty',
  more_than_received: 'qty',
  cost_invalid: 'unitCost',
  discount_invalid: 'discount',
};
export const lineFieldOf = (problem: string): LineField => LINE_FIELD[problem] ?? 'item';

/**
 * When a field's problem shows: once the field is left (`touch` on its blur), or for every field once Save draft or
 * Post is pressed (`showAll`). `focusFirst` then puts the cursor in the first marked field inside `root` (the form's
 * own element).
 */
export function useShownProblems(root: RefObject<HTMLElement | null>) {
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [all, setAll] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tick > 0) root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [root, tick]);
  return {
    all,
    shown: (key: string) => all || touched.has(key),
    touch: (key: string) => () => setTouched((s) => (s.has(key) ? s : new Set(s).add(key))),
    showAll: () => setAll(true),
    focusFirst: () => {
      setAll(true);
      setTick((x) => x + 1);
    },
  };
}

/**
 * The cursor goes to a line's item once the line added with Enter is drawn (W2-16): `addLine(n)` after adding line
 * `n`; the field's id is `idOf(n)`.
 */
export function useFocusNewLine(count: number, idOf: (i: number) => string) {
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (pending.current === null) return;
    document.getElementById(idOf(pending.current))?.focus();
    pending.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when a line is added
  }, [count]);
  return (n: number) => {
    pending.current = n;
  };
}

export interface LineNote {
  text: string;
  /** Amber: a warning that doesn't stop Post (a cost more than 10 % off the last). */
  warn?: boolean;
}

/**
 * A number box in a line's cell, filling its column: its problem under it (red), then its notes (the last cost, "Up to
 * 6"), all tied to the box for screen readers. Nothing else in the line moves when they appear.
 */
export function LineBox({
  label,
  error,
  notes = [],
  className,
  ...props
}: Omit<ComponentProps<'input'>, 'aria-label'> & { label: string; error?: ReactNode; notes?: LineNote[] }) {
  const id = useId();
  const ids = [...(error ? [`${id}-error`] : []), ...notes.map((_, k) => `${id}-note-${k}`)];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <TextBox
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.length > 0 ? ids.join(' ') : undefined}
        inputMode="decimal"
        className={cn('w-full text-end tabular-nums', className)}
        {...props}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="m-0 text-xs font-medium text-bad">
          {error}
        </p>
      )}
      {notes.map((n, k) => (
        <p
          key={k}
          id={`${id}-note-${k}`}
          className={cn(
            'm-0 text-end text-xs tabular-nums',
            n.warn ? 'font-medium text-warn' : 'text-muted-foreground',
          )}
        >
          {n.text}
        </p>
      ))}
    </div>
  );
}
