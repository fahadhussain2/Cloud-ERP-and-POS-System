import { cn } from '@erp/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { FIELD_BOX, SearchBox } from '../ui';
import type { PickedItem } from './data';

// The item of a receipt, return, transfer or adjustment line: type a code, name words, a barcode or an OEM number and
// pick from the list (W1-16, W1-18). Searches a moment after the last key, at `url` (purchasing's search by default).
// The results are drawn over the page, under the field: a line sits in a table whose scrolling container would cut a
// list inside it off (owner, staging 2026-11-08). ↑ ↓ move through them and Enter takes the highlighted one (W2-13).

interface Found {
  id: string;
  code: string;
  name: string;
}

const WAIT_MS = 200;

export function ItemPicker<T extends Found = PickedItem>({
  api,
  label,
  picked,
  onPick,
  disabled,
  url = '/api/purchasing/items',
}: {
  api: Api;
  label: string;
  picked: { code: string | null; name: string | null } | null;
  onPick: (item: T) => void;
  disabled?: boolean;
  url?: string;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<T[]>([]);
  const field = useRef<HTMLButtonElement>(null);
  // After a pick or Esc the focus goes back to the field, so Tab moves on to the line's next field (W2-16 point 2);
  // a click elsewhere closes the search without taking the focus back.
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    field.current?.focus();
  }, [open]);
  const start = (typed: string) => {
    setText(typed);
    setFound([]);
    setOpen(true);
  };
  const close = (back: boolean) => {
    refocus.current = back;
    setOpen(false);
  };

  useEffect(() => {
    if (!open || text.trim() === '') return;
    let live = true;
    const timer = setTimeout(() => {
      void api('GET', `${url}?q=${encodeURIComponent(text)}`).then(
        (r) => live && setFound(r.status === 200 ? (r.body as { items: T[] }).items : []),
      );
    }, WAIT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, text, open, url]);

  if (!open)
    return (
      <button
        ref={field}
        type="button"
        className={cn(FIELD_BOX, 'flex w-full items-center gap-1.5 truncate text-start disabled:opacity-60')}
        aria-label={label}
        disabled={disabled}
        onClick={() => start('')}
        // Reached with Tab, the field takes typing: a character opens the search with it, ↓ or Backspace opens it
        // empty (W2-16 point 1). Space and Enter still click; shortcuts (Ctrl, Alt, ⌘) are left alone.
        onKeyDown={(e) => {
          if (e.ctrlKey || e.altKey || e.metaKey) return;
          if (e.key.length === 1 && e.key !== ' ') {
            e.preventDefault();
            start(e.key);
          } else if (e.key === 'ArrowDown' || e.key === 'Backspace') {
            e.preventDefault();
            start('');
          }
        }}
      >
        {picked?.code ? (
          <>
            <span className="font-mono font-semibold">{picked.code}</span>
            <span className="truncate text-muted-foreground">{picked.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{t('purchasing.line.pick')}</span>
        )}
      </button>
    );
  return (
    <SearchBox
      autoFocus
      floating="page"
      label={label}
      listLabel={t('purchasing.line.results')}
      placeholder={t('purchasing.line.searchHint')}
      text={text}
      onText={setText}
      hits={text.trim() === '' ? [] : found}
      hitKey={(i) => i.id}
      onPick={(i) => {
        onPick(i);
        close(true);
      }}
      onEscape={() => close(true)}
      onBlur={() => setTimeout(() => close(false), 150)}
    >
      {(i) => (
        <>
          <span className="font-mono font-semibold">{i.code}</span> {i.name}
        </>
      )}
    </SearchBox>
  );
}
