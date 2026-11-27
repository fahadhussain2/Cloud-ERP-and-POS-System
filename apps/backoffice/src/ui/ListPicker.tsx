import { cn } from '@erp/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FIELD_LABEL } from './Field';
import { SearchBox } from './SearchBox';

// A pick from a list that keeps growing (owner answer 3: past about 15 options a search, not a dropdown), when the
// whole list is already on the screen (the suppliers in a screen's lookups): type a code or name, ↑ ↓ and Enter
// (W2-13). The picked one shows as "code · name"; typing again clears the pick until another is taken.

export interface ListPickerOption {
  id: string;
  /** Searched and shown before the name, where the list has codes (suppliers, categories). */
  code?: string;
  name: string;
}

const shown = (o: ListPickerOption) => (o.code ? `${o.code} · ${o.name}` : o.name);

const MOST = 20;

export function ListPicker({
  label,
  options,
  value,
  onChange,
  error,
  disabled,
  className,
  hideLabel = false,
  placeholder,
}: {
  label: string;
  options: readonly ListPickerOption[];
  /** The picked option's id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  error?: string | null | undefined;
  disabled?: boolean;
  className?: string;
  /** Read by screen readers but not shown: a filter in a list's toolbar. */
  hideLabel?: boolean;
  /** Shown while none is picked, e.g. "All categories" in a filter. */
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const picked = options.find((o) => o.id === value);
  // What was typed since the last pick; null shows the picked option.
  const [typed, setTyped] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const q = typed?.trim().toLowerCase() ?? '';
  const hits =
    q === '' || closed
      ? []
      : options
          .filter((o) => (o.code ?? '').toLowerCase().includes(q) || o.name.toLowerCase().includes(q))
          .slice(0, MOST);
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <span className={cn(FIELD_LABEL, hideLabel && 'sr-only')}>{label}</span>
      <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
        <SearchBox
          label={label}
          listLabel={label}
          placeholder={placeholder ?? t('app.searchCodeName')}
          text={typed ?? (picked ? shown(picked) : '')}
          onText={(v) => {
            setTyped(v);
            setClosed(false);
            if (value) onChange('');
          }}
          hits={hits}
          hitKey={(o) => o.id}
          onPick={(o) => {
            setTyped(null);
            onChange(o.id);
          }}
          onEscape={() => setClosed(true)}
          error={error ?? undefined}
        >
          {(o) => (
            <>
              {o.code && <span className="font-mono text-xs text-muted-foreground">{o.code}</span>} {o.name}
            </>
          )}
        </SearchBox>
      </fieldset>
    </div>
  );
}
