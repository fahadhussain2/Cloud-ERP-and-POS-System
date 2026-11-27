import { cn } from '@erp/ui';
import { useEffect, useState } from 'react';
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
        className={cn(FIELD_BOX, 'flex w-full items-center gap-1.5 truncate text-start disabled:opacity-60')}
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
        setOpen(false);
      }}
      onEscape={() => setOpen(false)}
      onBlur={() => setTimeout(() => setOpen(false), 150)}
    >
      {(i) => (
        <>
          <span className="font-mono font-semibold">{i.code}</span> {i.name}
        </>
      )}
    </SearchBox>
  );
}
