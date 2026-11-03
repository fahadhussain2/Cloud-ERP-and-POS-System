import { billAmounts, MAX_HOLD_LABEL_LENGTH } from '@erp/domain';
import { formatMoney, moveSelection, OptionList, TextField, type MoneyFormat } from '@erp/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { HeldBill } from '../db/held';
import { FormDialog } from './BillDialogs';

// Hold and recall (POS-08, POS spec §17, W1-12). `F8` sets the open bill aside with an optional label; `Shift+F8`
// lists the person's held bills, newest first: ↑ ↓ and Enter recall one (a second Enter swaps it with a bill that has
// lines), Del clears one after a second Del or Enter (owner answer 4: each person sees only their own).

/** `F8`: an optional label, then Enter holds the bill. `onHold` returns the i18n key of what is wrong, or null. */
export function HoldDialog({
  lineCount,
  onHold,
  onClose,
}: {
  lineCount: number;
  onHold: (label: string | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <FormDialog
      title={t('hold.title')}
      description={t('hold.help', { count: lineCount })}
      actionLabel={t('hold.action')}
      busy={busy}
      onClose={onClose}
      onSubmit={() => {
        if (busy) return;
        setBusy(true);
        void onHold(label).then((problem) => {
          setBusy(false);
          if (problem) setError(t(problem));
        });
      }}
    >
      <TextField
        label={t('hold.label')}
        placeholder={t('hold.labelHint')}
        autoComplete="off"
        autoFocus
        maxLength={MAX_HOLD_LABEL_LENGTH + 10}
        value={label}
        error={error}
        onChange={(e) => {
          setLabel(e.target.value);
          setError(null);
        }}
      />
    </FormDialog>
  );
}

type Confirm = { kind: 'swap'; bill: HeldBill } | { kind: 'clear'; bill: HeldBill };

/** `Shift+F8`: the person's held bills; `onRecall` and `onClear` return the i18n key of what is wrong, or null. */
export function RecallDialog({
  list,
  billHasLines,
  money,
  timeZone,
  onRecall,
  onClear,
  onClose,
}: {
  list: () => Promise<HeldBill[]>;
  /** The open bill has lines: recalling holds it first, after a second Enter. */
  billHasLines: boolean;
  money: MoneyFormat;
  timeZone: string;
  onRecall: (bill: HeldBill, swap: boolean) => Promise<string | null>;
  onClear: (bill: HeldBill) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [bills, setBills] = useState<HeldBill[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = () =>
    void list().then((found) => {
      setBills(found);
      setSelected((s) => Math.min(s, Math.max(found.length - 1, 0)));
    });
  useEffect(load, [list]);
  /** The list has the keys from the start: focused as it attaches, before the dialog would focus its first button. */
  const attach = useCallback((el: HTMLDivElement | null) => {
    if (el !== null && box.current === null) el.focus();
    box.current = el;
  }, []);

  const when = (iso: string) =>
    new Intl.DateTimeFormat(money.locale, { timeZone, timeStyle: 'short' }).format(new Date(iso));
  const name = (b: HeldBill) => b.label ?? b.bill.customer?.name ?? t('hold.walkin');

  /** Recalls or clears; the list is read again after a clear or a refusal (the dialog closes after a recall). */
  const run = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const problem = await work();
    setBusy(false);
    setConfirm(null);
    if (problem) setError(t(problem));
    load();
  };

  const recall = (i = selected) => {
    const bill = bills?.[i];
    if (!bill) return;
    if (confirm?.kind === 'clear') return void run(() => onClear(confirm.bill));
    if (billHasLines && confirm?.kind !== 'swap') return setConfirm({ kind: 'swap', bill });
    void run(() => onRecall(bill, billHasLines));
  };

  const clear = () => {
    const bill = bills?.[selected];
    if (!bill) return;
    if (confirm?.kind === 'clear') return void run(() => onClear(bill));
    setConfirm({ kind: 'clear', bill });
  };

  const description =
    confirm?.kind === 'swap'
      ? t('recall.swap', { name: name(confirm.bill) })
      : confirm?.kind === 'clear'
        ? t('recall.confirmClear', { name: name(confirm.bill) })
        : t('recall.help');

  return (
    <FormDialog
      title={t('recall.title')}
      description={description}
      actionLabel={
        confirm?.kind === 'clear'
          ? t('recall.clear')
          : confirm?.kind === 'swap'
            ? t('recall.swapAction')
            : t('recall.action')
      }
      busy={busy || !bills?.length}
      onClose={onClose}
      onSubmit={() => recall()}
    >
      <div
        ref={attach}
        // The list takes the keys: ↑ ↓ select, Enter recalls, Del clears; moving leaves a pending confirmation.
        tabIndex={-1}
        className="outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === box.current) {
            e.preventDefault();
            return recall();
          }
          if (e.key === 'Delete') {
            e.preventDefault();
            return clear();
          }
          const next = moveSelection(selected, e.key, bills?.length ?? 0);
          if (next === null) return;
          e.preventDefault();
          setConfirm(null);
          setSelected(next);
        }}
      >
        {bills !== null && bills.length === 0 ? (
          <p className="m-0 text-muted-foreground">{t('recall.empty')}</p>
        ) : (
          <OptionList
            id="held-bills"
            label={t('recall.title')}
            items={bills ?? []}
            selected={selected}
            itemKey={(b) => b.id}
            onSelect={(i) => {
              setConfirm(null);
              setSelected(i);
              box.current?.focus();
            }}
            onChoose={(i) => recall(i)}
            className="max-h-[50vh]"
          >
            {(b) => (
              <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-2 py-1.5">
                <span className="text-sm text-muted-foreground tabular-nums">{when(b.heldAt)}</span>
                <span className="truncate font-semibold">{name(b)}</span>
                <span className="text-sm text-muted-foreground">
                  {t('recall.items', { count: b.bill.bill.lines.length })}
                </span>
                <span className="text-end font-semibold tabular-nums">
                  {formatMoney(billAmounts(b.bill.bill).total, money)}
                </span>
              </div>
            )}
          </OptionList>
        )}
        {error && (
          <p role="alert" className="m-0 mt-2 text-danger">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
