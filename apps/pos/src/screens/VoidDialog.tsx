import { money as toMoney, parseBillCode } from '@erp/domain';
import { formatMoney, Input, moveSelection, OptionList, type MoneyFormat } from '@erp/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { VoidListBill } from '../db/void';
import { FormDialog } from './BillDialogs';

// Void a bill (`Alt+V`, POS-11, POS spec §18, W1-12): this counter's bills of today that aren't voided, newest first,
// filtered as the number is typed or by scanning the customer's paper bill; ↑ ↓ and Enter choose one. The cash desk
// check and the approver's PIN come next (CounterScreen).

/** A scanned bill code (`C03-S000412 4320`) is its number; anything else is typed text. */
const numberOf = (text: string): string => {
  try {
    return parseBillCode(text, toMoney(1)).number;
  } catch {
    return text;
  }
};

export function VoidDialog({
  list,
  money,
  timeZone,
  sellerName,
  onChoose,
  onClose,
}: {
  list: (filter: string) => Promise<VoidListBill[]>;
  money: MoneyFormat;
  timeZone: string;
  sellerName: (id: string) => string;
  onChoose: (bill: VoidListBill) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [bills, setBills] = useState<VoidListBill[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const request = ++latest.current;
    void list(numberOf(filter)).then((found) => {
      if (request !== latest.current) return;
      setBills(found);
      setSelected(0);
    });
  }, [list, filter]);

  const when = (iso: string) =>
    new Intl.DateTimeFormat(money.locale, { timeZone, timeStyle: 'short' }).format(new Date(iso));

  const choose = async (i = selected) => {
    const bill = bills?.[i];
    if (!bill || busy) return;
    setBusy(true);
    await onChoose(bill);
    setBusy(false);
  };

  return (
    <FormDialog
      title={t('void.title')}
      description={t('void.help')}
      actionLabel={t('void.choose')}
      busy={busy || !bills?.length}
      onClose={onClose}
      onSubmit={() => void choose()}
    >
      <Input
        ref={input}
        aria-label={t('void.search')}
        placeholder={t('void.search')}
        role="combobox"
        aria-expanded={(bills?.length ?? 0) > 0}
        aria-controls="void-bills"
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
        <p className="m-0 text-muted-foreground">{t(filter.trim() ? 'void.none' : 'void.empty')}</p>
      ) : (
        <OptionList
          id="void-bills"
          label={t('void.title')}
          items={bills ?? []}
          selected={selected}
          itemKey={(b) => b.id}
          onSelect={(i) => {
            setSelected(i);
            input.current?.focus();
          }}
          onChoose={(i) => void choose(i)}
          className="max-h-[50vh]"
        >
          {(b) => (
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-2 py-1.5">
              <span className="font-mono font-semibold">{b.number}</span>
              <span className="text-sm text-muted-foreground tabular-nums">{when(b.createdAt)}</span>
              <span className="truncate text-sm">{sellerName(b.sellerId)}</span>
              <span className="text-end font-semibold tabular-nums">{formatMoney(b.total, money)}</span>
            </div>
          )}
        </OptionList>
      )}
    </FormDialog>
  );
}
