import { cn, Input, moveSelection } from '@erp/ui';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { FIELD_BOX, FieldNote } from './Field';

// A search box with its results under it, worked from the keyboard (W2-13; PRD §1 principle 2, keyboard first): the
// first hit is highlighted, ↑ ↓ PageUp PageDown move the highlight (the shared moveSelection), Enter takes the
// highlighted hit, Esc closes the list; the mouse still clicks. A combobox with aria-activedescendant, so a screen
// reader follows the highlight while focus stays in the box. Used by the item search, the customer/supplier search
// and the searchable pickers (owner answer 3).
//
// `floating`: `page` draws the list over the page, under the box (a box in a table line, whose scrolling container
// would cut a list inside it off; owner, staging 2026-11-08); `inline` keeps it inside the box's container (a box in a
// dialog, where a list outside the dialog couldn't be clicked).

/** The list's gap from its box and from the window's edge, its full height (`max-h-64`), and the room under the box
 * below which it opens above instead (about five rows), in px. */
const GAP = 4;
const LIST_MAX = 256;
const ROOM = 160;

export function SearchBox<T>({
  label,
  listLabel,
  text,
  onText,
  hits,
  hitKey,
  children,
  onPick,
  onEscape,
  onBlur,
  placeholder,
  autoFocus,
  floating = 'inline',
  error,
  className,
}: {
  label: string;
  listLabel: string;
  text: string;
  onText: (text: string) => void;
  /** The results to show; none closes the list. */
  hits: readonly T[];
  hitKey: (hit: T) => string;
  /** How a hit reads in the list. */
  children: (hit: T) => ReactNode;
  onPick: (hit: T) => void;
  /** Esc: closes the list and anything else the caller wants. */
  onEscape: () => void;
  onBlur?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  floating?: 'page' | 'inline';
  /** The field's problem, shown under it (owner answer 6). */
  error?: ReactNode;
  className?: string;
}) {
  const listId = useId();
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Opened by a typed character (the item field, W2-16): the caret goes after it, so typing carries on.
  useEffect(() => {
    const box = input.current;
    if (autoFocus && box) box.setSelectionRange(box.value.length, box.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the box opens
  }, []);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  // New results start on their first hit (compared by their keys, so a caller may pass a fresh array each time).
  const keys = JSON.stringify(hits.map(hitKey));
  const [shown, setShown] = useState(keys);
  if (shown !== keys) {
    setShown(keys);
    setActive(0);
  }
  const open = hits.length > 0;
  const optionId = (i: number) => `${listId}-${i}`;

  // Under the box, or above it when the window has no room under it (W2-16 point 3): kept there while the page
  // scrolls or resizes. Drawn over the page (`page`), or inside the box's container (`inline`).
  useLayoutEffect(() => {
    if (!open) return;
    const follow = () => {
      const r = field.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 2 * GAP;
      const above = r.top - 2 * GAP;
      const up = below < ROOM && above > below;
      const maxHeight = Math.min(LIST_MAX, up ? above : below);
      if (floating === 'inline') {
        setPlace(
          up ? { bottom: '100%', marginBottom: GAP, maxHeight } : { top: '100%', marginTop: GAP, maxHeight },
        );
        return;
      }
      const at = { position: 'fixed' as const, left: r.left, width: Math.max(r.width, 280), maxHeight };
      setPlace(up ? { ...at, bottom: window.innerHeight - r.top + GAP } : { ...at, top: r.bottom + GAP });
    };
    follow();
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [floating, open]);

  // The highlight stays in view as it moves.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId only joins listId, which never changes
  }, [active, open]);

  const list = open && (
    <ul
      id={listId}
      role="listbox"
      aria-label={listLabel}
      style={place ?? (floating === 'page' ? { position: 'fixed', visibility: 'hidden' } : { top: '100%' })}
      className={cn(
        'z-50 m-0 max-h-64 list-none overflow-auto rounded-xl border border-line bg-surface p-1 shadow-panel',
        floating === 'inline' && 'absolute inset-x-0',
      )}
    >
      {hits.map((h, i) => (
        <li
          key={hitKey(h)}
          id={optionId(i)}
          role="option"
          aria-selected={i === active}
          className="cursor-pointer rounded-md px-2.5 py-1.5 text-sm aria-selected:bg-surface-2"
          // Keep focus in the box, so the click doesn't close the list first.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => onPick(h)}
        >
          {children(h)}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={cn('relative', className)} ref={field}>
      <Input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${listId}-note` : undefined}
        ref={input}
        autoFocus={autoFocus}
        className={FIELD_BOX}
        value={text}
        placeholder={placeholder}
        onChange={(e) => onText(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            // The list closes first; a dialog around it stays open.
            if (open) e.stopPropagation();
            onEscape();
            return;
          }
          if (e.key === 'Enter') {
            const hit = hits[active];
            if (!hit) return;
            e.preventDefault();
            onPick(hit);
            return;
          }
          const next = moveSelection(active, e.key, hits.length);
          if (next === null) return;
          e.preventDefault();
          setActive(next);
        }}
      />
      {floating === 'page' && list ? createPortal(list, document.body) : list}
      <FieldNote id={`${listId}-note`} error={error} />
    </div>
  );
}
