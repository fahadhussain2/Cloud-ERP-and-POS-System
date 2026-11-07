import { Input } from '@erp/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import type { PickedItem } from './data';

// The item of a receipt, return, transfer or adjustment line: type a code, name words, a barcode or an OEM number and
// pick from the list (W1-16, W1-18). Searches a moment after the last key, at `url` (purchasing's search by default).

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
  const listId = useId();

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
        type="button"
        className="w-full rounded-md border border-input bg-surface-2 px-2 py-1.5 text-start disabled:opacity-60"
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setText('');
          setFound([]);
          setOpen(true);
        }}
      >
        {picked?.code ? (
          <>
            <span className="font-mono font-semibold">{picked.code}</span>{' '}
            <span className="text-muted-foreground">{picked.name}</span>
          </>
        ) : (
          <span className="text-muted-foreground">{t('purchasing.line.pick')}</span>
        )}
      </button>
    );
  return (
    <div className="relative">
      <Input
        autoFocus
        aria-label={label}
        aria-controls={listId}
        className="h-9"
        value={text}
        placeholder={t('purchasing.line.searchHint')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && found[0]) {
            e.preventDefault();
            onPick(found[0]);
            setOpen(false);
          }
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {found.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('purchasing.line.results')}
          className="absolute inset-x-0 top-full z-10 m-0 max-h-64 list-none overflow-auto rounded-md border border-input bg-surface p-1 shadow-md"
        >
          {found.map((i) => (
            <li key={i.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="w-full rounded px-2 py-1 text-start hover:bg-surface-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(i);
                  setOpen(false);
                }}
              >
                <span className="font-mono font-semibold">{i.code}</span> {i.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
