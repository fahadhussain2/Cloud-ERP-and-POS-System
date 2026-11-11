import {
  parseWholeAmount,
  qty,
  refundFor,
  returnable,
  RETURN_CONDITIONS,
  RETURN_REASONS,
  DomainError,
  type Money,
  type ReturnCondition,
  type ReturnLineInput,
  type ReturnReason,
  type ReturnSource,
} from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Button,
  formatMoney,
  Input,
  Label,
  LABEL_CLASS,
  moveSelection,
  OptionList,
  plainAmount,
  type MoneyFormat,
} from '@erp/ui';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { formatQty, parseQuantity } from '../bill/bill-state';
import type { LineItem } from '../bill/open-bill';
import type { Counter } from '../counter';
import type { FoundBill, ReturnableBill } from '../db/returns';
import type { BillItem, SearchResult } from '../search/search-index';
import { FormDialog } from './BillDialogs';

// Return and exchange (`F3`, POS-12, PRD W6, POS spec §19, W1-13): find the bill (scan its code, type its number, a
// phone or a date), mark what comes back of each line with a reason and a condition, and put it on the bill; or, with
// no receipt (a lost bill, a bill from before go-live), pick the items and the refund price, which a manager approves
// next. The approval and the bill itself are CounterScreen's; the rules are the domain's (`addReturn`).

/** What the dialog hands back: the return's source and lines, and how each item shows on the bill. */
export interface ReturnChoice {
  source: ReturnSource;
  lines: ReturnLineInput[];
  items: Record<string, LineItem>;
}

type ReturnCounter = Pick<Counter, 'findBills' | 'returnableBill' | 'billItem' | 'search' | 'noReceiptPrice'>;

interface Mark {
  qty: string;
  reason: ReturnReason;
  condition: ReturnCondition;
  note: string;
}
const NO_MARK: Mark = { qty: '', reason: 'wrong_part', condition: 'resellable', note: '' };

interface NoReceiptRow extends Mark {
  item: BillItem;
  price: string;
  suggested: Money | null;
}

type Step =
  | { step: 'find' }
  | {
      step: 'lines';
      bill: ReturnableBill;
      items: Record<string, BillItem | null>;
      marks: Record<number, Mark>;
    }
  | { step: 'none'; ref: string; rows: NoReceiptRow[] };

const lineItemOf = (i: BillItem | null | undefined, id: string): LineItem =>
  i
    ? { code: i.code, name: i.name, variant: i.variant, spec: i.spec }
    : { code: '', name: id, variant: null, spec: null };

const SELECT =
  'h-9 rounded-md border border-line bg-surface px-2 text-sm focus-visible:outline-2 focus-visible:outline-focus';

export function ReturnDialog({
  counter,
  money,
  timeZone,
  windowDays,
  today,
  initialBillId,
  beforeOpen,
  onChoose,
  onClose,
}: {
  counter: ReturnCounter;
  money: MoneyFormat;
  timeZone: string;
  /** The tenant's window, for the hint on an old bill. */
  windowDays: number;
  /** Today's business date. */
  today: string;
  /** A bill to open at once (W1-23: a void whose money had arrived becomes its return). */
  initialBillId?: string;
  /**
   * Guard 1 (W1-23): asked before a bill's lines open; false when the bill isn't returned here (it is voided
   * instead, and the counter has taken over).
   */
  beforeOpen?: (bill: { id: string; number: string }) => Promise<boolean>;
  /** Puts the return on the bill (after an approval, if it needs one); answers the i18n key of what is wrong. */
  onChoose: (choice: ReturnChoice) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const m = (minor: number) => formatMoney(minor, money);
  const [state, setState] = useState<Step>({ step: 'find' });
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FoundBill[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  // The no-receipt item search.
  const [itemQuery, setItemQuery] = useState('');
  const [items, setItems] = useState<SearchResult[]>([]);
  const [itemSel, setItemSel] = useState(0);

  /** Searches the bills as the text is typed or scanned; an older answer never replaces a newer one. */
  const findBills = (text: string) => {
    setQuery(text);
    setError(null);
    const request = ++latest.current;
    if (text.trim() === '') return setFound([]);
    void counter.findBills(text).then((list) => {
      if (request !== latest.current) return;
      setFound(list);
      setSelected(0);
    });
  };
  /** Searches the catalog for a no-receipt return. */
  const findItems = (text: string) => {
    setItemQuery(text);
    const request = ++latest.current;
    if (text.trim() === '') return setItems([]);
    void counter.search(text).then((r) => {
      if (request !== latest.current) return;
      setItems(r);
      setItemSel(0);
    });
  };

  const date = (iso: string) =>
    new Intl.DateTimeFormat(money.locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  const daysSince = (businessDate: string) =>
    Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${businessDate}T00:00:00Z`)) / 86_400_000);
  const errorKey = (code: string) => (i18n.exists(`error.${code}`) ? `error.${code}` : 'error.other');

  const openBill = async (b: Pick<FoundBill, 'id'>) => {
    const bill = await counter.returnableBill(b.id);
    if (bill === null) return setError(t('return.notHere'));
    if (beforeOpen && !(await beforeOpen({ id: bill.id, number: bill.number }))) return;
    const ids = [...new Set(bill.lines.map((l) => l.itemId))];
    const looked = await Promise.all(ids.map((id) => counter.billItem(id, null)));
    setError(null);
    setState({
      step: 'lines',
      bill,
      items: Object.fromEntries(ids.map((id, i) => [id, looked[i] ?? null])),
      marks: {},
    });
  };

  const opened = useRef(false);
  useEffect(() => {
    if (initialBillId === undefined || opened.current) return;
    opened.current = true;
    void openBill({ id: initialBillId });
    // Once, for the bill the dialog was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBillId]);

  const addNoReceiptItem = async (r: SearchResult) => {
    if (state.step !== 'none') return;
    const item = await counter.billItem(r.id, null);
    if (!item) return;
    const suggested = await counter.noReceiptPrice(item.itemId);
    setState({
      ...state,
      rows: [
        ...state.rows,
        {
          ...NO_MARK,
          reason: 'changed_mind',
          qty: '1',
          item,
          suggested,
          price: suggested === null ? '' : plainAmount(suggested, money.minorUnits),
        },
      ],
    });
    findItems('');
  };

  const submit = async () => {
    if (busy) return;
    let choice: ReturnChoice;
    try {
      choice =
        state.step === 'lines' ? fromLines(state) : state.step === 'none' ? fromNoReceipt(state) : null!;
    } catch (err) {
      if (err instanceof DomainError) return setError(t(errorKey(err.code)));
      if (err instanceof Error && err.message.startsWith('return.')) return setError(t(err.message));
      throw err;
    }
    if (!choice) return;
    setBusy(true);
    const problem = await onChoose(choice);
    setBusy(false);
    if (problem) setError(t(problem));
  };

  const parseQty = (text: string, allowsFraction: boolean) => {
    const q = parseQuantity(text);
    if (typeof q === 'string') throw new DomainError(q, text);
    if (!allowsFraction && q % 1000 !== 0) throw new DomainError('invalid_quantity', text);
    return q;
  };

  const fromLines = (s: Extract<Step, { step: 'lines' }>): ReturnChoice => {
    const lines: ReturnLineInput[] = [];
    for (const l of s.bill.lines) {
      const mark = s.marks[l.lineNo];
      if (!mark || mark.qty.trim() === '') continue;
      const item = s.items[l.itemId];
      lines.push({
        id: crypto.randomUUID(),
        itemId: l.itemId,
        qty: parseQty(mark.qty, item?.allowsFraction ?? l.qty % 1000 !== 0),
        allowsFraction: item?.allowsFraction ?? l.qty % 1000 !== 0,
        reason: mark.reason,
        note: mark.note.trim() === '' ? null : mark.note,
        condition: mark.condition,
        original: { line: l, returned: l.returned },
        price: null,
        suggested: null,
      });
    }
    if (lines.length === 0) throw new Error('return.markSomething');
    return {
      source: {
        kind: 'bill',
        id: s.bill.id,
        number: s.bill.number,
        businessDate: s.bill.businessDate,
        customerId: s.bill.customerId,
      },
      lines,
      items: Object.fromEntries(Object.entries(s.items).map(([id, i]) => [id, lineItemOf(i, id)])),
    };
  };

  const fromNoReceipt = (s: Extract<Step, { step: 'none' }>): ReturnChoice => {
    if (s.rows.length === 0) throw new Error('return.markSomething');
    return {
      source: { kind: 'none', ref: s.ref.trim() === '' ? null : s.ref.trim() },
      lines: s.rows.map((r) => ({
        id: crypto.randomUUID(),
        itemId: r.item.itemId,
        qty: parseQty(r.qty, r.item.allowsFraction),
        allowsFraction: r.item.allowsFraction,
        reason: r.reason,
        note: r.note.trim() === '' ? null : r.note,
        condition: r.condition,
        original: null,
        price: r.price.trim() === '' ? null : parseWholeAmount(r.price, money.minorUnits),
        suggested: r.suggested,
      })),
      items: Object.fromEntries(s.rows.map((r) => [r.item.itemId, lineItemOf(r.item, r.item.itemId)])),
    };
  };

  const markFields = (mark: Mark, set: (m: Mark) => void, label: string) => (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>{t('return.qtyBack')}</span>
        <Input
          aria-label={`${t('return.qtyBack')} · ${label}`}
          className="h-9 w-20 font-mono"
          inputMode="decimal"
          autoComplete="off"
          value={mark.qty}
          onChange={(e) => {
            set({ ...mark, qty: e.target.value });
            setError(null);
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>{t('return.reasonLabel')}</span>
        <select
          aria-label={`${t('return.reasonLabel')} · ${label}`}
          className={SELECT}
          value={mark.reason}
          onChange={(e) => {
            const reason = e.target.value as ReturnReason;
            // A defective part goes to Damaged (D-008).
            set({ ...mark, reason, condition: reason === 'defective' ? 'defective' : mark.condition });
          }}
        >
          {RETURN_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`return.reason.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={LABEL_CLASS}>{t('return.conditionLabel')}</span>
        <select
          aria-label={`${t('return.conditionLabel')} · ${label}`}
          className={SELECT}
          value={mark.condition}
          onChange={(e) => set({ ...mark, condition: e.target.value as ReturnCondition })}
        >
          {RETURN_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {t(`return.condition.${c}`)}
            </option>
          ))}
        </select>
      </label>
      {mark.reason === 'other' && (
        <label className="flex min-w-40 flex-1 flex-col gap-1">
          <span className={LABEL_CLASS}>{t('return.note')}</span>
          <Input
            aria-label={`${t('return.note')} · ${label}`}
            className="h-9"
            maxLength={200}
            value={mark.note}
            onChange={(e) => set({ ...mark, note: e.target.value })}
          />
        </label>
      )}
    </div>
  );

  const onFindKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = moveSelection(selected, e.key, found.length);
    if (next !== null) {
      e.preventDefault();
      setSelected(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const b = found[selected];
      if (b) void openBill(b);
    }
  };
  const onItemKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = moveSelection(itemSel, e.key, items.length);
    if (next !== null) {
      e.preventDefault();
      setItemSel(next);
    } else if (e.key === 'Enter' && items[itemSel]) {
      e.preventDefault();
      e.stopPropagation();
      void addNoReceiptItem(items[itemSel]);
    }
  };

  // One dialog for every step: swapping dialogs would move the focus out of the new one, which closes it.
  const view =
    state.step === 'find'
      ? {
          title: t('return.title'),
          description: t('return.help'),
          actionLabel: t('return.open'),
          onSubmit: () => {
            const b = found[selected];
            if (b) void openBill(b);
          },
          body: findBody(),
        }
      : state.step === 'lines'
        ? {
            title: t('return.linesTitle', { number: state.bill.number }),
            description: t('return.linesHelp', { date: date(state.bill.createdAt) }),
            actionLabel: busy ? t('pay.saving') : t('return.add'),
            onSubmit: () => void submit(),
            body: linesBody(state),
          }
        : {
            title: t('return.noReceiptTitle'),
            description: t('return.noReceiptHelp'),
            actionLabel: busy ? t('pay.saving') : t('return.add'),
            onSubmit: () => void submit(),
            body: noneBody(state),
          };
  return (
    <FormDialog
      title={view.title}
      description={view.description}
      actionLabel={view.actionLabel}
      busy={busy}
      onClose={onClose}
      onSubmit={view.onSubmit}
    >
      {view.body}
    </FormDialog>
  );

  function findBody() {
    return (
      <>
        {' '}
        <Label htmlFor="return-search" className={LABEL_CLASS}>
          {t('return.search')}
        </Label>
        <Input
          id="return-search"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          value={query}
          onChange={(e) => findBills(e.target.value)}
          onKeyDown={onFindKey}
        />
        {query.trim() !== '' && found.length === 0 ? (
          <p className="m-0 text-muted-foreground">{t('return.none')}</p>
        ) : (
          <OptionList
            id="return-bills"
            label={t('return.bills')}
            items={found}
            selected={selected}
            itemKey={(b) => b.id}
            onSelect={setSelected}
            onChoose={(i) => void openBill(found[i]!)}
            className="max-h-72"
          >
            {(b) => (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-2 py-1.5">
                <span className="flex flex-col">
                  <span className="font-mono font-semibold">{b.number}</span>
                  <span className="text-xs text-muted-foreground">
                    {date(b.createdAt)}
                    {daysSince(b.businessDate) > windowDays &&
                      ` · ${t('return.outsideWindow', { days: windowDays })}`}
                  </span>
                </span>
                <span className="tabular-nums">{m(b.total)}</span>
              </div>
            )}
          </OptionList>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError(null);
            setState({ step: 'none', ref: '', rows: [] });
          }}
        >
          {t('return.noReceipt')}
        </Button>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </>
    );
  }

  function linesBody(s: Extract<Step, { step: 'lines' }>) {
    return (
      <>
        {' '}
        <div className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
          {s.bill.lines.map((l) => {
            const item = s.items[l.itemId];
            const name = item?.name ?? l.itemId;
            if (l.isReturn) return null;
            const left = returnable(l, l.returned);
            const perUnit = left.qty > 0 ? refundFor(l, l.returned, qty(Math.min(1000, left.qty))) : 0;
            return (
              <div
                key={l.lineNo}
                className="flex flex-col gap-1 border-b border-line pb-2"
                data-testid="return-line"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">
                    {l.lineNo}. {name}{' '}
                    <span className="font-mono text-xs text-muted-foreground">{item?.code}</span>
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {t('return.lineFacts', {
                      sold: formatQty(l.qty, money.locale),
                      back: formatQty(l.returned.qty, money.locale),
                      left: formatQty(left.qty, money.locale),
                      price: m(perUnit),
                    })}
                  </span>
                </div>
                {left.qty > 0 ? (
                  markFields(
                    s.marks[l.lineNo] ?? NO_MARK,
                    (mark) => setState({ ...s, marks: { ...s.marks, [l.lineNo]: mark } }),
                    name,
                  )
                ) : (
                  <span className="text-sm text-muted-foreground">{t('return.allBack')}</span>
                )}
              </div>
            );
          })}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </>
    );
  }

  function noneBody(s: Extract<Step, { step: 'none' }>) {
    return (
      <>
        {' '}
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>{t('return.ref')}</span>
          <Input
            className="font-mono"
            maxLength={40}
            autoComplete="off"
            value={s.ref}
            onChange={(e) => setState({ ...s, ref: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>{t('return.itemSearch')}</span>
          <Input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={itemQuery}
            onChange={(e) => findItems(e.target.value)}
            onKeyDown={onItemKey}
          />
        </label>
        {items.length > 0 && (
          <OptionList
            id="return-items"
            label={t('search.results')}
            items={items}
            selected={itemSel}
            itemKey={(r) => r.id}
            onSelect={setItemSel}
            onChoose={(i) => void addNoReceiptItem(items[i]!)}
            className="max-h-40"
          >
            {(r) => (
              <div className="px-2 py-1">
                <span className="font-mono text-xs">{r.code}</span> {r.name}
              </div>
            )}
          </OptionList>
        )}
        <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
          {s.rows.map((r, i) => (
            <div
              key={`${r.item.itemId}-${i}`}
              className="flex flex-col gap-1 border-b border-line pb-2"
              data-testid="return-line"
            >
              <span className="font-medium">
                {r.item.name} <span className="font-mono text-xs text-muted-foreground">{r.item.code}</span>
              </span>
              <div className="flex flex-wrap items-end gap-2">
                {markFields(
                  r,
                  (mark) => setState({ ...s, rows: s.rows.map((x, j) => (j === i ? { ...x, ...mark } : x)) }),
                  r.item.name,
                )}
                <label className="flex flex-col gap-1">
                  <span className={LABEL_CLASS}>{t('return.price')}</span>
                  <Input
                    aria-label={`${t('return.price')} · ${r.item.name}`}
                    className="h-9 w-28 font-mono"
                    inputMode="numeric"
                    autoComplete="off"
                    value={r.price}
                    onChange={(e) =>
                      setState({
                        ...s,
                        rows: s.rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)),
                      })
                    }
                  />
                </label>
              </div>
              <span className="text-xs text-muted-foreground">
                {r.suggested === null
                  ? t('return.noSuggestion')
                  : t('return.suggested', { price: m(r.suggested) })}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </>
    );
  }
}
