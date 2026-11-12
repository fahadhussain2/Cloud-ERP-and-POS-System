import { formatMoney, Input, moveSelection, OptionList, type MoneyFormat } from '@erp/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DocumentSummary } from '../db/checkout';
import { FormDialog } from './BillDialogs';

// Reprint (`Alt+P`, POS spec §13, POS-10, owner answer 3): this counter's bills of the last 30 days, newest first,
// filtered as the number is typed; ↑ ↓ and Enter reprint the selected one. Anyone unlocked may reprint, without a PIN.

const DAYS = 30;

export function ReprintDialog({
  list,
  money,
  timeZone,
  onReprint,
  onClose,
}: {
  list: (since: string, filter: string) => Promise<DocumentSummary[]>;
  money: MoneyFormat;
  timeZone: string;
  onReprint: (bill: DocumentSummary) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [bills, setBills] = useState<DocumentSummary[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const request = ++latest.current;
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    void list(since, filter).then((found) => {
      if (request !== latest.current) return;
      setBills(found);
      setSelected(0);
    });
  }, [list, filter]);

  const when = (iso: string) =>
    new Intl.DateTimeFormat(money.locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );

  const reprint = async (i = selected) => {
    const bill = bills?.[i];
    if (!bill || busy) return;
    setBusy(true);
    await onReprint(bill);
    setBusy(false);
  };

  return (
    <FormDialog
      title={t('reprint.title')}
      description={t('reprint.help')}
      actionLabel={t('reprint.action')}
      busy={busy || !bills?.length}
      onClose={onClose}
      onSubmit={() => void reprint()}
    >
      <Input
        ref={input}
        aria-label={t('reprint.search')}
        placeholder={t('reprint.search')}
        role="combobox"
        aria-expanded={(bills?.length ?? 0) > 0}
        aria-controls="reprint-bills"
        autoComplete="off"
        autoFocus
        className="font-mono"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          const next = moveSelection(selected, e.key, bills?.length ?? 0);
          if (next === null) return;
          e.preventDefault();
          setSelected(next);
        }}
      />
      {bills !== null && bills.length === 0 ? (
        <p className="m-0 text-muted-foreground">{t(filter.trim() ? 'reprint.none' : 'reprint.empty')}</p>
      ) : (
        <OptionList
          id="reprint-bills"
          label={t('reprint.title')}
          items={bills ?? []}
          selected={selected}
          itemKey={(b) => b.id}
          onSelect={(i) => {
            setSelected(i);
            input.current?.focus();
          }}
          onChoose={(i) => void reprint(i)}
          className="max-h-[50vh]"
        >
          {(b) => (
            <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-2 py-1.5">
              <span className="font-mono font-semibold">
                {b.number}
                {b.voidNumber && (
                  <span className="ms-2 font-sans text-xs font-bold text-bad">{t('reprint.voided')}</span>
                )}
              </span>
              <span className="text-sm text-muted-foreground">{when(b.createdAt)}</span>
              <span className="text-end font-semibold tabular-nums">{formatMoney(b.total, money)}</span>
            </div>
          )}
        </OptionList>
      )}
    </FormDialog>
  );
}
