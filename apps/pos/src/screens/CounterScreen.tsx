import { uuidv7 } from '@erp/contracts';
import {
  add,
  approve,
  billAmounts,
  changeTier,
  DomainError,
  effectiveLimits,
  hasListPrice,
  parseDiscount,
  parseWholeAmount,
  pendingApprovals,
  removeLine,
  saleTotal,
  setBillDiscount,
  setQty,
  setUnitPrice,
  type ApprovalTarget,
  type DomainErrorCode,
  type Money,
  type PendingApproval,
  type Qty,
  type SaleDocument,
  type Tender,
} from '@erp/domain';
import {
  Badge,
  formatMoney,
  Input,
  KeyBar,
  Kbd,
  Label,
  LABEL_CLASS,
  moveSelection,
  OptionList,
  Panel,
  plainAmount,
  useShortcuts,
  type KeyHint,
  type MoneyFormat,
} from '@erp/ui';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { setBillOpen } from '../bill/bill-open';
import { addItem, formatQty, parseQuantity, quantityPrefix, tryEdit } from '../bill/bill-state';
import { useOpenBill, type BillCounter } from '../bill/use-open-bill';
import type { Counter } from '../counter';
import type { CheckoutSettings, DocumentSummary, PaymentMethodRow } from '../db/checkout';
import type { PrintJob } from '../print/print-job';
import type { BillItem, SearchResult, Vehicle } from '../search/search-index';
import { checkApprover } from '../unlock/approve';
import type { StaffUser } from '../unlock/unlock';
import { ApprovalDialog, ConfirmDialog, EntryDialog, TierDialog, type ApprovalAttempt } from './BillDialogs';
import { BillPanel } from './BillPanel';
import { CashDialog, MethodDialog, SplitDialog } from './PaymentDialogs';
import { PaymentPad } from './PaymentPad';
import { ReprintDialog } from './ReprintDialog';

// The counter screen (POS spec §9–§11, POS-02, POS-03, POS-04, PLT-07): search on the left, the bill on the right,
// the key bar along the bottom. Every key press searches the local catalog; an older answer never replaces a newer
// one. Enter (or a scan) adds the selected item; Tab moves to the bill lines, where single keys change a line.

const CATALOG_POLL_MS = 1000;
/** Carried by every document (sync spec §6.1); the server accepts the previous version too (architecture §4.2). */
const CLIENT_VERSION = import.meta.env.VITE_ERP_VERSION ?? 'dev';
/** The counter's clock at finalize (the document's createdAt). */
const nowMs = () => Date.now();

type Zone = 'search' | 'bill';

type DialogState =
  | { kind: 'qty'; lineId: string }
  | { kind: 'price'; lineId: string }
  | { kind: 'newPrice'; item: BillItem; qty: Qty }
  | { kind: 'discount' }
  | { kind: 'tier' }
  | { kind: 'clear' }
  | { kind: 'approval'; pending: PendingApproval }
  | { kind: 'cash' }
  | { kind: 'method'; method: PaymentMethodRow }
  | { kind: 'split' }
  | { kind: 'reprint' };

export type CounterScreenCounter = BillCounter &
  Pick<
    Counter,
    | 'search'
    | 'catalog'
    | 'billItem'
    | 'tierPrices'
    | 'grants'
    | 'getPinState'
    | 'setPinState'
    | 'verifyPin'
    | 'recordPinEvent'
    | 'checkout'
    | 'finalize'
    | 'recentBills'
    | 'bill'
    | 'recordReprint'
    | 'print'
  >;

const sameTarget = (a: ApprovalTarget, b: ApprovalTarget) =>
  a === 'bill' || b === 'bill' ? a === b : a.lineId === b.lineId;

export function CounterScreen({
  counter,
  money,
  user,
  staff,
  branchId,
  shopName,
  onLock,
  onSaved,
}: {
  counter: CounterScreenCounter;
  money: MoneyFormat;
  /** The person selling: every bill is theirs (POS spec §5). */
  user: StaffUser;
  /** Who may be picked as an approver (unlockable staff). */
  staff: StaffUser[];
  branchId: string | null;
  /** Printed at the top of every bill. */
  shopName: string;
  onLock: () => void;
  /** A bill was saved: the unsynced count goes up (POS spec §7). */
  onSaved?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [text, setText] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [catalog, setCatalog] = useState<{ items: number; ready: boolean } | null>(null);
  const latest = useRef(0);
  /** The answer for the text in the box, so Enter right after typing (a scan) adds the right item. */
  const answer = useRef<Promise<SearchResult[]>>(Promise.resolve([]));
  const shown = useRef({ results, selected });
  useEffect(() => {
    shown.current = { results, selected };
  }, [results, selected]);

  const { openBill, tiers, change, clear, get, saveFailed } = useOpenBill(counter, user.id);
  const [zone, setZone] = useState<Zone>('search');
  const [lineSel, setLineSel] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** What the last bill came to, until the next one starts (POS spec §12, after the commit). */
  const [notice, setNotice] = useState<string | null>(null);
  /** Rounding, payment methods and the print profile; null before the first pull. */
  const [settings, setSettings] = useState<CheckoutSettings | null>(null);
  /** The seller's discount limit; null until their roles have loaded, and no approval is judged before then. */
  const [maxDiscountBp, setMaxDiscountBp] = useState<number | null>(null);

  const lines = openBill?.bill.lines ?? [];
  const tierId = openBill?.bill.tierId;
  const amounts = openBill ? billAmounts(openBill.bill) : null;
  const pending = openBill && maxDiscountBp !== null ? pendingApprovals(openBill.bill, maxDiscountBp) : [];
  const total = openBill && settings ? saleTotal(openBill.bill, settings.increment) : null;

  useEffect(() => {
    let stop = false;
    void counter.checkout().then((s) => {
      if (!stop) setSettings(s);
    });
    return () => {
      stop = true;
    };
  }, [counter]);

  // The seller's discount limit, from their roles in this branch (PRD §4).
  useEffect(() => {
    let stop = false;
    void counter.grants(user.id).then((g) => {
      if (!stop) setMaxDiscountBp(effectiveLimits(g, branchId).maxDiscountBp);
    });
    return () => {
      stop = true;
    };
  }, [counter, user.id, branchId]);

  // An app update waits while this bill has lines (POS spec §8).
  const hasLines = lines.length > 0;
  useEffect(() => setBillOpen(hasLines), [hasLines]);
  useEffect(() => () => setBillOpen(false), []);

  // Until the first catalog load has finished, show its progress instead of the search (POS spec §9).
  const ready = catalog?.ready ?? false;
  useEffect(() => {
    if (ready) return;
    let stop = false;
    const check = async () => {
      const c = await counter.catalog();
      if (!stop) setCatalog(c);
    };
    void check();
    const timer = setInterval(() => void check(), CATALOG_POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [counter, ready]);

  // The bill lines take the keyboard when their zone is on.
  useEffect(() => {
    if (zone === 'bill' && dialog === null) panel.current?.focus();
  }, [zone, dialog]);

  const errorKey = (code: DomainErrorCode) =>
    i18n.exists(`error.${code}`) ? `error.${code}` : 'error.other';
  const show = (code: DomainErrorCode) => setMessage(t(errorKey(code)));
  /** A typed value through a domain parser: the value, or the i18n key of what is wrong with it. */
  const parse = <T,>(fn: () => T): { ok: true; value: T } | { ok: false; key: string } => {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      if (err instanceof DomainError) return { ok: false, key: errorKey(err.code) };
      throw err;
    }
  };

  const type = (value: string, tier = tierId) => {
    setText(value);
    const request = ++latest.current;
    const { query } = quantityPrefix(value);
    if (query.trim() === '') {
      answer.current = Promise.resolve([]);
      setResults([]);
      return;
    }
    const found = counter.search(query, tier ? { tierId: tier } : undefined);
    answer.current = found;
    void found.then((r) => {
      if (request !== latest.current) return;
      setResults(r);
      setSelected(0);
    });
  };

  const focusSearch = () => {
    setZone('search');
    input.current?.focus();
    input.current?.select();
  };
  const clearSearch = () => {
    type('');
    input.current?.focus();
  };
  const move = (key: string) => {
    const next = moveSelection(selected, key, results.length);
    if (next !== null) setSelected(next);
    return next !== null;
  };
  const toLines = () => {
    const n = get()?.bill.lines.length ?? 0;
    if (n === 0) return;
    setLineSel((s) => Math.min(s, n - 1));
    setZone('bill');
  };

  /** Opens the approval a target still needs, if any (POS spec §10). */
  const askApproval = (target: ApprovalTarget) => {
    const ob = get();
    if (!ob || maxDiscountBp === null) return;
    const p = pendingApprovals(ob.bill, maxDiscountBp).find((x) => sameTarget(x.target, target));
    if (p) setDialog({ kind: 'approval', pending: p });
  };

  /** Adds an item; the broken rule comes back, e.g. `price_required` for an item without a list price. */
  const addBillItem = (item: BillItem, qty: Qty, unitPrice?: Money): DomainErrorCode | null => {
    const id = uuidv7();
    const err = change((ob) => addItem(ob, item, qty, id, unitPrice));
    if (err) return err;
    setMessage(null);
    setNotice(null);
    const now = get()!.bill.lines;
    const added = now.findIndex((l) => l.id === id);
    setLineSel(added >= 0 ? added : now.findLastIndex((l) => l.itemId === item.itemId));
    type('');
    if (unitPrice !== undefined) askApproval({ lineId: id });
    return null;
  };

  /** Enter (or a scan): the selected result, once the search for what is in the box has answered. */
  const addSelected = async () => {
    const request = latest.current;
    const { qty, query } = quantityPrefix(text);
    if (query.trim() === '' || !openBill) return;
    const list = await answer.current;
    if (request !== latest.current) return;
    const { results: onScreen, selected: sel } = shown.current;
    const r = list[list === onScreen ? sel : 0];
    if (!r) return;
    const item = await counter.billItem(r.id, openBill.bill.tierId);
    if (!item) return;
    // Whether the item has a price is the domain's call: without one, the salesman types it (POS spec §10).
    const err = addBillItem(item, qty);
    if (err === 'price_required') setDialog({ kind: 'newPrice', item, qty });
    else if (err) show(err);
  };

  const editLine = (edit: Parameters<typeof tryEdit>[1]) => {
    const err = change((ob) => tryEdit(ob, edit));
    if (err) show(err);
    else setMessage(null);
    return err;
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void addSelected();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      toLines();
    } else if (move(e.key)) e.preventDefault();
  };

  const lineAction = (key: string) => {
    const ob = get();
    const line = ob?.bill.lines[lineSel];
    if (!ob || !line) return;
    const step = 1000 as Qty;
    switch (key) {
      case '+':
        return editLine((b) => setQty(b, line.id, (line.qty + step) as Qty));
      case '-':
        if (line.qty > step) editLine((b) => setQty(b, line.id, (line.qty - step) as Qty));
        return;
      case 'q':
        return setDialog({ kind: 'qty', lineId: line.id });
      case 'p':
        return setDialog({ kind: 'price', lineId: line.id });
      case 'd':
        return setDialog({ kind: 'discount' });
      case 'Delete': {
        editLine((b) => removeLine(b, line.id));
        const left = get()?.bill.lines.length ?? 0;
        if (left === 0) return focusSearch();
        setLineSel(Math.min(lineSel, left - 1));
        return;
      }
    }
  };

  const onBillKey = (e: KeyboardEvent<HTMLElement>) => {
    if (dialog !== null || e.ctrlKey || e.metaKey || e.altKey || e.target !== panel.current) return;
    const k = e.key;
    const next = moveSelection(lineSel, k, lines.length);
    if (next !== null) {
      e.preventDefault();
      setLineSel(next);
    } else if (k === 'Escape' || k === 'Tab') {
      e.preventDefault();
      focusSearch();
    } else if (k === '+' || k === '=' || k === '-') {
      e.preventDefault();
      lineAction(k === '=' ? '+' : k);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      lineAction('Delete');
    } else if (['q', 'p', 'd'].includes(k.toLowerCase())) {
      e.preventDefault();
      lineAction(k.toLowerCase());
    } else if (k.length === 1) {
      // Any other letter types into the search (POS spec §11).
      e.preventDefault();
      focusSearch();
      type(text + k);
    }
  };

  /** Opens a payment popup (POS spec §12): never for an empty bill, nor while a price waits for an approval. */
  const openPay = async (kind: 'cash' | 'split' | PaymentMethodRow) => {
    const ob = get();
    if (!ob || ob.bill.lines.length === 0 || maxDiscountBp === null) return;
    if (pendingApprovals(ob.bill, maxDiscountBp).length > 0) return setMessage(t('pay.approveFirst'));
    // Fresh each time: the first pull may have brought the methods since the screen opened.
    const s = await counter.checkout();
    setSettings(s);
    if (!s || s.methods.length === 0) return setMessage(t('pay.notReady'));
    setMessage(null);
    setDialog(
      kind === 'cash'
        ? { kind: 'cash' }
        : kind === 'split'
          ? { kind: 'split' }
          : { kind: 'method', method: kind },
    );
  };

  const methodName = (code: string) => settings?.methods.find((x) => x.code === code)?.name ?? code;
  const tenantZone = () => settings?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const itemName = (i: { name: string; variant: string | null }) =>
    [i.name, i.variant].filter(Boolean).join(' ');

  /** Sends a bill to the printer; a print that fails changes nothing, and Alt+P prints it again (POS spec §13). */
  const printDocument = (document: SaleDocument, items: PrintJob['items'], reprint: PrintJob['reprint']) => {
    try {
      counter.print({
        document,
        profile: settings?.printProfile ?? null,
        shopName,
        headerLines: [...(settings?.receiptHeader ?? []), ...(settings?.printProfile?.headerLines ?? [])],
        items,
        sellerName: nameOf(document.sellerId),
        methodNames: Object.fromEntries((settings?.methods ?? []).map((x) => [x.code, x.name])),
        money,
        timeZone: tenantZone(),
        reprint,
      });
    } catch (err) {
      void counter.log('bill.print_failed', { number: document.number, error: String(err) });
    }
  };

  const describe = (d: SaleDocument) => {
    const cash = d.payments.find((p) => p.changeDue !== null);
    if (!cash)
      return t('pay.doneNoCash', {
        number: d.number,
        methods: d.payments.map((p) => methodName(p.method)).join(' + '),
      });
    if (cash.changeDue)
      return t('pay.doneChange', { number: d.number, cash: m(d.cashDue), change: m(cash.changeDue) });
    return t('pay.done', { number: d.number, cash: m(d.cashDue) });
  };

  /** Finalize & print (POS spec §12): saved first, in one local transaction; printed only after the commit. */
  const pay = async (tender: Tender): Promise<string | null> => {
    const ob = get();
    let saved;
    try {
      saved = await counter.finalize({
        userId: user.id,
        id: uuidv7(),
        createdAtMs: nowMs(),
        clientVersion: CLIENT_VERSION,
        tender,
      });
    } catch (err) {
      if (err instanceof DomainError) return errorKey(err.code);
      void counter.log('bill.finalize_failed', { sellerId: user.id, error: String(err) });
      return 'pay.failed';
    }
    const { document, repeated } = saved;
    setDialog(null);
    await clear();
    // A second Enter gets the same bill back: it was printed the first time.
    if (!repeated)
      printDocument(
        document,
        Object.fromEntries(
          Object.entries(ob?.items ?? {}).map(([id, i]) => [id, { code: i.code, name: itemName(i) }]),
        ),
        null,
      );
    setNotice(describe(document));
    onSaved?.();
    focusSearch();
    return null;
  };

  /** Reprint (POS spec §13): marked REPRINT with when and who, and kept for the audit log. */
  const reprintBill = async (summary: DocumentSummary) => {
    const document = await counter.bill(summary.id);
    if (!document) return;
    const at = new Date().toISOString();
    await counter.recordReprint({ documentId: document.id, number: document.number, userId: user.id, at });
    const ids = [...new Set(document.lines.map((l) => l.itemId))];
    const found = await Promise.all(ids.map((id) => counter.billItem(id, null)));
    const items = Object.fromEntries(
      ids.flatMap((id, i) => {
        const item = found[i];
        return item ? [[id, { code: item.code, name: itemName(item) }] as const] : [];
      }),
    );
    printDocument(document, items, { at, by: user.fullName });
    setDialog(null);
    setNotice(t('reprint.done', { number: document.number }));
    focusSearch();
  };

  const openTier = () => tiers.length > 0 && setDialog({ kind: 'tier' });
  const openClear = () => (get()?.bill.lines.length ?? 0) > 0 && setDialog({ kind: 'clear' });
  const ignore = () => {};
  // F1, F3, F5 never reach the browser on the counter (no help page, find bar or reload mid-bill).
  useShortcuts(
    {
      F2: focusSearch,
      F7: openTier,
      'Alt+C': openClear,
      'Alt+L': onLock,
      F9: () => void openPay('cash'),
      'Shift+F9': () => void openPay('split'),
      'Alt+P': () => setDialog({ kind: 'reprint' }),
      F1: ignore,
      F3: ignore,
      F5: ignore,
    },
    dialog === null,
  );

  const m = (minor: number) => formatMoney(minor, money);
  const nameOf = (id: string) =>
    staff.find((u) => u.id === id)?.fullName ?? (id === user.id ? user.fullName : id);
  const lineOf = (id: string) => openBill?.bill.lines.find((l) => l.id === id);

  const attempt =
    (p: PendingApproval): ApprovalAttempt =>
    async (approver, pin, reason, note) => {
      const [before, grants] = await Promise.all([
        counter.getPinState(approver.id),
        counter.grants(approver.id),
      ]);
      const r = await checkApprover({
        approver,
        approverState: before,
        approverGrants: grants,
        branchId,
        need: p.need,
        discountBp: p.discountBp,
        pin,
        verify: (v, x) => counter.verifyPin(v, x),
      });
      await counter.setPinState(approver.id, r.approverState);
      if (!before.locked && r.approverState.locked)
        await counter.recordPinEvent({
          kind: 'locked',
          userId: approver.id,
          byUserId: null,
          at: new Date().toISOString(),
        });
      await counter.log(`approval.${r.result}`, {
        sellerId: user.id,
        approverId: approver.id,
        need: p.need,
        target: p.target,
      });
      if (r.result === 'approved') {
        // The dialog opens only once the seller's limit is known (askApproval).
        editLine((b) =>
          approve(b, p.target, maxDiscountBp!, {
            approvedBy: approver.id,
            reason,
            note,
            at: new Date().toISOString(),
          }),
        );
        setDialog(null);
      }
      return { result: r.result, failures: r.approverState.failures };
    };

  const approvalFacts = (p: PendingApproval): [string, ReactNode][] => {
    if (p.target === 'bill')
      return [
        [t('approval.billDiscount'), m(openBill?.bill.billDiscount ?? 0)],
        [t('approval.seller'), user.fullName],
      ];
    const line = lineOf(p.target.lineId);
    if (!line) return [];
    return [
      [t('approval.item'), openBill?.items[line.itemId]?.name ?? line.itemId],
      [t('approval.list'), hasListPrice(line.list) ? m(line.list) : t('bill.noList')],
      [t('approval.floor'), line.floor !== null ? m(line.floor) : t('bill.noFloor')],
      [t('approval.requested'), m(line.unitPrice)],
      [t('approval.seller'), user.fullName],
    ];
  };

  const vehicle = (v: Vehicle | null) => {
    if (!v) return null;
    const years =
      v.yearFrom !== null && v.yearTo !== null
        ? t('search.years', { from: v.yearFrom, to: v.yearTo })
        : v.yearFrom !== null
          ? t('search.yearsFrom', { from: v.yearFrom })
          : v.yearTo !== null
            ? t('search.yearsTo', { to: v.yearTo })
            : null;
    return [v.make, v.model, years].filter(Boolean).join(' ');
  };

  const count =
    text.trim() === ''
      ? t('search.items', { count: catalog?.items ?? 0 })
      : results.length >= 50
        ? t('search.top', { count: results.length })
        : t('search.found', { count: results.length });

  const common: KeyHint[] = [
    { keys: 'F9', label: t('keys.pay'), run: () => void openPay('cash') },
    { keys: 'F7', label: t('keys.tier'), run: openTier },
    { keys: 'Alt+C', label: t('keys.clearBill'), run: openClear },
    { keys: 'Alt+P', label: t('keys.reprint'), run: () => setDialog({ kind: 'reprint' }) },
    { keys: 'Alt+L', label: t('keys.lock'), run: onLock },
  ];
  const hints: KeyHint[] =
    zone === 'bill'
      ? [
          {
            keys: '↑ ↓',
            label: t('keys.line'),
            run: () => setLineSel((s) => Math.min(s + 1, lines.length - 1)),
          },
          { keys: '+ −', label: t('keys.qty'), run: () => lineAction('+') },
          { keys: 'Q', label: t('keys.setQty'), run: () => lineAction('q') },
          { keys: 'P', label: t('keys.price'), run: () => lineAction('p') },
          { keys: 'D', label: t('keys.discount'), run: () => lineAction('d') },
          { keys: 'Del', label: t('keys.remove'), run: () => lineAction('Delete') },
          { keys: 'Esc', label: t('keys.back'), run: focusSearch },
          ...common,
        ]
      : [
          { keys: 'F2', label: t('keys.search'), run: focusSearch },
          { keys: '↑ ↓', label: t('keys.select'), run: () => void move('ArrowDown') },
          { keys: 'Enter', label: t('keys.add'), run: () => void addSelected(), main: true },
          { keys: 'Esc', label: t('keys.clear'), run: clearSearch },
          { keys: 'Tab', label: t('keys.toLines'), run: toLines },
          ...common,
        ];

  const dialogLine = dialog && 'lineId' in dialog ? lineOf(dialog.lineId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-2.5 max-[780px]:grid-cols-1">
        <Panel
          aria-label={t('search.panel')}
          className={`flex min-h-0 flex-col overflow-hidden ${zone === 'search' ? 'border-focus' : ''}`}
        >
          {!ready ? (
            <div className="flex flex-col gap-2 px-3.5 py-5" role="status">
              <p className="m-0 font-display text-xl font-semibold">
                {t('catalog.loading', { count: catalog?.items ?? 0 })}
              </p>
              <p className="m-0 text-muted-foreground">{t('catalog.help')}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-2">
                <Label htmlFor="search" className={LABEL_CLASS}>
                  {t('search.label')} <Kbd>F2</Kbd>
                </Label>
                <Input
                  id="search"
                  ref={input}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  className="h-11 bg-surface-2 font-mono text-base focus-visible:bg-surface"
                  placeholder={t('search.placeholder')}
                  role="combobox"
                  aria-expanded={results.length > 0}
                  aria-controls="results"
                  aria-activedescendant={results.length > 0 ? `results-${selected}` : undefined}
                  value={text}
                  onFocus={() => setZone('search')}
                  onChange={(e) => type(e.target.value)}
                  onKeyDown={onSearchKey}
                />
              </div>
              <div className="flex justify-between px-3.5 pb-1.5 text-[11.5px] text-muted-foreground">
                <span>{count}</span>
                <span>{t('search.priceHead')}</span>
              </div>
              {text.trim() === '' ? (
                <p className="m-0 px-3.5 py-4 text-muted-foreground">{t('search.hint')}</p>
              ) : results.length === 0 ? (
                <p className="m-0 px-3.5 py-4 text-muted-foreground">
                  {t('search.none', { text: text.trim() })}
                </p>
              ) : (
                <OptionList
                  id="results"
                  label={t('search.results')}
                  items={results}
                  selected={selected}
                  itemKey={(r) => r.id}
                  onSelect={(i) => {
                    setSelected(i);
                    input.current?.focus();
                  }}
                  onChoose={(i) => {
                    setSelected(i);
                    shown.current = { results, selected: i };
                    void addSelected();
                  }}
                  className="flex-1 px-1.5 pb-2"
                >
                  {(r) => (
                    <div className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-[7px]">
                      <span className="font-mono text-[12.5px] font-semibold">{r.code}</span>
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium wrap-anywhere">
                          {r.name}{' '}
                          {r.status !== 'active' && (
                            <Badge variant="outline" className="border-transparent bg-warn-soft text-warn">
                              {t(`item.status.${r.status}`)}
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground wrap-anywhere">
                          {[
                            [r.variant, r.spec].filter(Boolean).join(' '),
                            r.oem && t('search.oem', { oem: r.oem }),
                            vehicle(r.vehicle),
                            r.bin && t('search.bin', { bin: r.bin }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="min-w-[76px] text-end font-semibold whitespace-nowrap tabular-nums">
                        {r.price === null ? (
                          <span className="font-normal text-muted-foreground">{t('search.noPrice')}</span>
                        ) : (
                          formatMoney(r.price, money)
                        )}
                      </span>
                    </div>
                  )}
                </OptionList>
              )}
            </>
          )}
        </Panel>
        <BillPanel
          openBill={openBill}
          amounts={amounts}
          total={total}
          pending={pending}
          tierName={tiers.find((x) => x.id === tierId)?.name ?? ''}
          selected={lineSel}
          active={zone === 'bill'}
          message={saveFailed ? t('bill.saveFailed') : message}
          notice={notice}
          money={money}
          nameOf={nameOf}
          pad={
            <PaymentPad
              methods={settings?.methods ?? []}
              disabled={lines.length === 0}
              onCash={() => void openPay('cash')}
              onMethod={(method) => void openPay(method)}
              onSplit={() => void openPay('split')}
            />
          }
          panelRef={panel}
          onSelect={(i) => {
            setLineSel(i);
            setZone('bill');
          }}
          onKeyDown={onBillKey}
        />
      </div>
      <KeyBar title={zone === 'bill' ? t('keys.lines') : t('keys.counter')} hints={hints} />

      {dialog?.kind === 'qty' && dialogLine && (
        <EntryDialog
          title={t('qty.title')}
          description={openBill?.items[dialogLine.itemId]?.name}
          label={t('qty.label')}
          initial={formatQty(dialogLine.qty, 'en')}
          actionLabel={t('qty.action')}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            const q = parseQuantity(value);
            if (typeof q === 'string') return errorKey(q);
            const err = change((ob) => tryEdit(ob, (b) => setQty(b, dialogLine.id, q)));
            if (err) return errorKey(err);
            setDialog(null);
            return null;
          }}
        />
      )}
      {dialog?.kind === 'price' && dialogLine && (
        <EntryDialog
          title={t('price.title')}
          description={openBill?.items[dialogLine.itemId]?.name}
          label={t('price.label')}
          facts={[
            [t('approval.list'), hasListPrice(dialogLine.list) ? m(dialogLine.list) : t('bill.noList')],
            [t('approval.floor'), dialogLine.floor !== null ? m(dialogLine.floor) : t('bill.noFloor')],
          ]}
          initial={plainAmount(dialogLine.unitPrice, money.minorUnits)}
          actionLabel={t('price.action')}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            const price = parse(() => parseWholeAmount(value, money.minorUnits));
            if (!price.ok) return price.key;
            const err = change((ob) => tryEdit(ob, (b) => setUnitPrice(b, dialogLine.id, price.value)));
            if (err) return errorKey(err);
            setMessage(null);
            setDialog(null);
            askApproval({ lineId: dialogLine.id });
            return null;
          }}
        />
      )}
      {dialog?.kind === 'newPrice' && (
        <EntryDialog
          title={t('price.newTitle')}
          description={t('price.noList')}
          label={t('price.label')}
          facts={[[t('approval.item'), dialog.item.name]]}
          initial=""
          actionLabel={t('price.action')}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            const price = parse(() => parseWholeAmount(value, money.minorUnits));
            if (!price.ok) return price.key;
            setDialog(null);
            const err = addBillItem(dialog.item, dialog.qty, price.value);
            if (err) show(err);
            return null;
          }}
        />
      )}
      {dialog?.kind === 'discount' && amounts && (
        <EntryDialog
          title={t('discount.title')}
          label={t('discount.label')}
          facts={[[t('discount.lines'), m(add(amounts.total, amounts.billDiscount))]]}
          initial={amounts.billDiscount > 0 ? plainAmount(amounts.billDiscount, money.minorUnits) : ''}
          actionLabel={t('discount.action')}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            const base = add(amounts.total, amounts.billDiscount);
            const amount = parse(() => parseDiscount(value, base, money.minorUnits));
            if (!amount.ok) return amount.key;
            const err = change((ob) => tryEdit(ob, (b) => setBillDiscount(b, amount.value)));
            if (err) return errorKey(err);
            setMessage(null);
            setDialog(null);
            askApproval('bill');
            return null;
          }}
        />
      )}
      {dialog?.kind === 'tier' && openBill && (
        <TierDialog
          tiers={tiers}
          current={openBill.bill.tierId}
          onClose={() => setDialog(null)}
          onChoose={(id) => {
            void (async () => {
              const ob = get()!;
              const prices = await counter.tierPrices([...new Set(ob.bill.lines.map((l) => l.itemId))], id);
              editLine((b) => changeTier(b, id, prices));
              setDialog(null);
              type(text, id);
            })();
          }}
        />
      )}
      {dialog?.kind === 'clear' && (
        <ConfirmDialog
          title={t('clear.title')}
          body={t('clear.body')}
          actionLabel={t('clear.action')}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            void clear(); // a failure shows on the bill panel (saveFailed)
            setDialog(null);
            setMessage(null);
            focusSearch();
          }}
        />
      )}
      {dialog?.kind === 'cash' && settings && total && (
        <CashDialog
          settings={settings}
          total={total.total}
          money={money}
          onPay={pay}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'method' && settings && total && (
        <MethodDialog
          method={dialog.method}
          settings={settings}
          total={total.total}
          money={money}
          onPay={pay}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'split' && settings && total && (
        <SplitDialog
          settings={settings}
          total={total.total}
          money={money}
          onPay={pay}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'reprint' && (
        <ReprintDialog
          list={counter.recentBills}
          money={money}
          timeZone={tenantZone()}
          onReprint={reprintBill}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'approval' && (
        <ApprovalDialog
          pending={dialog.pending}
          facts={approvalFacts(dialog.pending)}
          staff={staff}
          onApprove={attempt(dialog.pending)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
