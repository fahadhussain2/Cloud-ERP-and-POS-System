import { uuidv7 } from '@erp/contracts';
import {
  add,
  addReturn,
  money as toMoney,
  negate,
  approve,
  billAmounts,
  businessDate,
  can,
  changeTier,
  checkCredit,
  CREDIT_REASONS,
  DomainError,
  effectiveLimits,
  hasListPrice,
  parseDiscount,
  parseWholeAmount,
  pendingApprovals,
  reissueBill,
  RETURN_APPROVAL_REASONS,
  returnNeeds,
  removeLine,
  saleTotal,
  setBillDiscount,
  setQty,
  setUnitPrice,
  onAccountAmount,
  type ApprovalTarget,
  type CreditApproval,
  type CreditNeed,
  type CreditReason,
  type CreditView,
  type DomainErrorCode,
  type OverrideReason,
  type Money,
  type PendingApproval,
  type Qty,
  type ReturnApprovalBy,
  type ReturnApprovalKind,
  type ReturnApprovalReason,
  type RoleGrant,
  type AnySaleDocument,
  type SaleDocument,
  type Tender,
  type SaleVoidDocument,
  type VoidReason,
  VOID_REASONS,
  answeredParts,
  paymentParts,
  returnWouldBeVoid,
  voidOrReturn,
  type PaymentAnswer,
  type PaymentMethodCode,
  type PaymentPart,
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
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { setBillOpen } from '../bill/bill-open';
import { addItem, formatQty, parseQuantity, quantityPrefix, setCustomer, tryEdit } from '../bill/bill-state';
import type { BillCustomer } from '../bill/open-bill';
import { useOpenBill, type BillCounter } from '../bill/use-open-bill';
import type { Counter } from '../counter';
import type { CheckoutSettings, DocumentSummary, PaymentMethodRow } from '../db/checkout';
import type { CounterCustomer } from '../db/customers';
import type { HeldBill } from '../db/held';
import type { VoidListBill } from '../db/void';
import type { DeskCheck } from '../sync/bills';
import type { PrintJob } from '../print/print-job';
import type { BillItem, SearchResult, Vehicle } from '../search/search-index';
import {
  checkApprover,
  checkCreditApprover,
  checkReturnApprover,
  checkVoidApprover,
} from '../unlock/approve';
import type { StaffUser } from '../unlock/unlock';
import { ApprovalDialog, ConfirmDialog, EntryDialog, TierDialog, type ApprovalAttempt } from './BillDialogs';
import { BillPanel } from './BillPanel';
import { CustomerDialog, customerStrip, type CustomerChoice } from './CustomerDialog';
import { CashDialog, MethodDialog, OnAccountDialog, RefundDialog, SplitDialog } from './PaymentDialogs';
import { HoldDialog, RecallDialog } from './HoldDialogs';
import { PaymentPad, type PadMode } from './PaymentPad';
import { PaymentQuestionDialog } from './PaymentQuestionDialog';
import { ReturnDialog, type ReturnChoice } from './ReturnDialog';
import { CLIENT_VERSION } from '../version';
import { ReprintDialog } from './ReprintDialog';
import { VoidDialog } from './VoidDialog';

// The counter screen (POS spec §9–§11, §15, POS-02, POS-03, POS-04, POS-05, POS-07, PLT-07): search on the left, the bill on the right,
// the key bar along the bottom. Every key press searches the local catalog; an older answer never replaces a newer
// one. Enter (or a scan) adds the selected item; Tab moves to the bill lines, where single keys change a line.

const CATALOG_POLL_MS = 1000;
/** The counter's clock at finalize (the document's createdAt). */
const nowMs = () => Date.now();

type Zone = 'search' | 'bill';

/** The person's answers to the payment questions (W1-23), by method. */
type Answers = Partial<Record<PaymentMethodCode, PaymentAnswer>>;

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
  | { kind: 'reprint' }
  | { kind: 'hold' }
  | { kind: 'recall' }
  | { kind: 'void' }
  | { kind: 'voidApproval'; bill: VoidListBill; desk: DeskCheck; answers: Answers }
  /** A payment part the counter can't know about (W1-23): asked before a void, or before a return of an unpaid bill. */
  | {
      kind: 'paymentQuestion';
      bill: VoidListBill;
      desk: DeskCheck;
      part: PaymentPart;
      answers: Answers;
      purpose: 'void' | 'return';
    }
  /** Guard 1 (W1-23): a return of this counter's bill of today not yet paid at the desk is a void instead. */
  | { kind: 'voidInstead'; bill: VoidListBill; desk: DeskCheck; answers: Answers }
  | { kind: 'reissue'; sale: SaleDocument }
  | { kind: 'customer' }
  | { kind: 'onAccount'; figures: CreditView }
  | { kind: 'creditApproval'; tender: Tender; needs: CreditNeed[]; overLimitBy: Money; overCapBy: Money }
  | { kind: 'return'; windowDays: number; billId?: string }
  | { kind: 'returnApproval'; choice: ReturnChoice; needs: ReturnApprovalKind[] }
  | { kind: 'refund'; to: 'cash' | 'account' | 'transfer' }
  | { kind: 'refundApproval'; tender: Tender }
  | { kind: 'even' };

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
    | 'customers'
    | 'creditFigures'
    | 'holdBill'
    | 'heldBills'
    | 'recallBill'
    | 'clearHeld'
    | 'voidableBills'
    | 'deskCheck'
    | 'voidBill'
    | 'voidOf'
    | 'findBills'
    | 'returnableBill'
    | 'noReceiptPrice'
    | 'returnPolicy'
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
  offline,
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
  /** What the status bar shows: while offline, the offline daily cap applies (POS spec §15). */
  offline: boolean;
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

  const { openBill, tiers, change, clear, load, get, saveFailed } = useOpenBill(counter, user.id);
  /** How many bills this person has held here (POS spec §17), shown on the recall key. */
  const [heldCount, setHeldCount] = useState(0);
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
  const [sellerGrants, setSellerGrants] = useState<RoleGrant[]>([]);
  /** This counter's customers (POS spec §15), refreshed whenever the customer dialog opens. */
  const [customers, setCustomers] = useState<CounterCustomer[]>([]);

  const lines = openBill?.bill.lines ?? [];
  const tierId = openBill?.bill.tierId;
  const amounts = openBill ? billAmounts(openBill.bill) : null;
  const pending = openBill && maxDiscountBp !== null ? pendingApprovals(openBill.bill, maxDiscountBp) : [];
  const total = openBill && settings ? saleTotal(openBill.bill, settings.increment) : null;
  /** What comes back on this bill (W1-13, POS spec §19). */
  const returns = openBill?.bill.returns ?? null;
  /** The pad pays, refunds or settles an even exchange (POS-17, D-053). */
  const padMode: PadMode =
    returns === null || total === null
      ? 'pay'
      : total.total < 0
        ? 'refund'
        : total.total === 0
          ? 'even'
          : 'pay';

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
      if (stop) return;
      setMaxDiscountBp(effectiveLimits(g, branchId).maxDiscountBp);
      setSellerGrants(g);
    });
    return () => {
      stop = true;
    };
  }, [counter, user.id, branchId]);

  useEffect(() => {
    let stop = false;
    void counter.customers().then((list) => {
      if (!stop) setCustomers(list);
    });
    return () => {
      stop = true;
    };
  }, [counter]);

  // The person's held bills on this counter; reading them sweeps the expired ones (POS spec §17).
  const heldList = useCallback(() => counter.heldBills(user.id), [counter, user.id]);
  const countHeld = async () => setHeldCount((await heldList()).length);
  useEffect(() => {
    let stop = false;
    void counter.heldBills(user.id).then((list) => {
      if (!stop) setHeldCount(list.length);
    });
    return () => {
      stop = true;
    };
  }, [counter, user.id]);

  // Who the bill is for, and whether it may go on account (POS spec §15).
  const billCustomer = openBill?.customer ?? null;
  const customerRow = billCustomer ? customers.find((c) => c.id === billCustomer.id) : undefined;
  const maySellCredit = can(sellerGrants, 'pos.credit.sell', branchId);
  const onAccountBlocked = !customerRow?.account.creditAllowed
    ? t('credit.needsCustomer')
    : !maySellCredit
      ? t('credit.notPermitted')
      : null;

  // An app update waits while this bill has lines (POS spec §8), returned ones too.
  const hasLines = lines.length > 0 || returns !== null;
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
    const empty = ob?.bill.lines.length === 0 && (ob.bill.returns ?? null) === null;
    if (!ob || empty || maxDiscountBp === null) return;
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

  /** F9 on a return: refund cash at the desk, or finalize an even exchange (POS-17). */
  const payOrRefund = () => {
    if (padMode === 'refund') return openRefund('cash');
    if (padMode === 'even') return setDialog({ kind: 'even' });
    void openPay('cash');
  };
  const openRefund = (to: 'cash' | 'account' | 'transfer') => {
    const ob = get();
    if (!ob || (ob.bill.returns ?? null) === null || !settings) return;
    if (maxDiscountBp !== null && pendingApprovals(ob.bill, maxDiscountBp).length > 0)
      return setMessage(t('pay.approveFirst'));
    setMessage(null);
    setDialog({ kind: 'refund', to });
  };
  /** A refund to account needs a customer with an account (PRD W7); the customer list only has such customers. */
  const refundAccountBlocked = customerRow ? null : t('refund.needsCustomer');

  const methodName = (code: string) => settings?.methods.find((x) => x.code === code)?.name ?? code;
  const tenantZone = () => settings?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const itemName = (i: { name: string; variant: string | null }) =>
    [i.name, i.variant].filter(Boolean).join(' ');

  /** Sends a bill to the printer; a print that fails changes nothing, and Alt+P prints it again (POS spec §13). */
  const printDocument = (
    document: AnySaleDocument,
    items: PrintJob['items'],
    reprint: PrintJob['reprint'],
    voided: SaleVoidDocument | null = null,
  ) => {
    const c = document.customerId === null ? undefined : customers.find((x) => x.id === document.customerId);
    try {
      counter.print({
        document,
        customer:
          document.customerId === null ? null : { code: c?.code ?? '', name: c?.name ?? document.customerId },
        profile: settings?.printProfile ?? null,
        shopName,
        headerLines: [...(settings?.receiptHeader ?? []), ...(settings?.printProfile?.headerLines ?? [])],
        items,
        sellerName: nameOf(document.sellerId),
        methodNames: Object.fromEntries((settings?.methods ?? []).map((x) => [x.code, x.name])),
        money,
        timeZone: tenantZone(),
        reprint,
        voided: voided && {
          number: voided.number,
          at: voided.createdAt,
          by: nameOf(voided.userId),
          approvedBy: nameOf(voided.approvedBy),
          reason: voided.note ?? t(`override.reason.${voided.reason}`),
        },
      });
    } catch (err) {
      void counter.log('bill.print_failed', { number: document.number, error: String(err) });
    }
  };

  const describe = (d: AnySaleDocument) => {
    if (d.version === 2) {
      const refund = d.payments.find((p) => p.amount < 0);
      if (d.payments.length === 0) return t('return.doneEven', { number: d.number });
      if (refund?.method === 'cash')
        return t('return.doneRefund', { number: d.number, cash: m(negate(refund.amount)) });
      if (refund?.method === 'on_account')
        return t('return.doneAccount', { number: d.number, amount: m(negate(refund.amount)) });
      if (refund) return t('return.doneTransfer', { number: d.number, method: methodName(refund.method) });
    }
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

  /**
   * Finalize & print (POS spec §12): saved first, in one local transaction; printed only after the commit. An
   * on-account part over the customer's limit or the offline cap first asks for an approval (POS spec §15).
   */
  const pay = async (
    tender: Tender,
    creditApproval: CreditApproval | null = null,
    refundApproval: ReturnApprovalBy | null = null,
  ): Promise<string | null> => {
    const ob = get();
    const customerId = ob?.customer?.id ?? null;
    const amount = onAccountAmount(tender.payments);
    if (amount > 0 && creditApproval === null) {
      if (customerId === null) return 'tender.on_account_needs_customer';
      const c = checkCredit({ ...(await counter.creditFigures(customerId, offline)), amount });
      if (!c.allowed) return 'tender.on_account_needs_customer';
      if (c.needs.length > 0) {
        setDialog({
          kind: 'creditApproval',
          tender,
          needs: c.needs,
          overLimitBy: c.overLimitBy,
          overCapBy: c.overCapBy,
        });
        return null;
      }
    }
    let saved;
    try {
      saved = await counter.finalize({
        userId: user.id,
        id: uuidv7(),
        createdAtMs: nowMs(),
        clientVersion: CLIENT_VERSION,
        tender,
        offline,
        creditApproval,
        refundApproval,
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
    // The balances on screen stay as pulled; the next pull brings this bill into them.
    void counter.customers().then(setCustomers);
    setNotice(describe(document));
    onSaved?.();
    focusSearch();
    return null;
  };

  /** The code and name of each item on a stored bill, from the local catalog (an item gone from it shows its id). */
  const itemsOf = async (document: AnySaleDocument) => {
    const ids = [...new Set(document.lines.map((l) => l.itemId))];
    const found = await Promise.all(ids.map((id) => counter.billItem(id, null)));
    return {
      found: Object.fromEntries(ids.map((id, i) => [id, found[i] ?? null])),
      items: Object.fromEntries(
        ids.flatMap((id, i) => {
          const item = found[i];
          return item ? [[id, { code: item.code, name: itemName(item) }] as const] : [];
        }),
      ),
    };
  };

  /** Reprint (POS spec §13): marked REPRINT with when and who, and kept for the audit log; a voided bill as VOID. */
  const reprintBill = async (summary: DocumentSummary) => {
    const document = await counter.bill(summary.id);
    if (!document) return;
    const at = new Date().toISOString();
    await counter.recordReprint({ documentId: document.id, number: document.number, userId: user.id, at });
    const [{ items }, voided] = await Promise.all([itemsOf(document), counter.voidOf(document.id)]);
    printDocument(document, items, { at, by: user.fullName }, voided);
    setDialog(null);
    setNotice(t('reprint.done', { number: document.number }));
    focusSearch();
  };

  const openTier = () => tiers.length > 0 && setDialog({ kind: 'tier' });
  const openCustomer = async () => {
    setCustomers(await counter.customers());
    setDialog({ kind: 'customer' });
  };
  /** Picks the bill's customer (or walk-in) and their tier, as F7 would change it (POS spec §15). */
  const chooseCustomer = async (choice: CustomerChoice) => {
    const ob = get();
    if (!ob) return;
    const fallback = tiers.find((x) => x.isDefault)?.id ?? ob.bill.tierId;
    const theirs = choice.customer?.account.tierId;
    const tier =
      theirs !== undefined ? (tiers.some((x) => x.id === theirs) ? theirs : ob.bill.tierId) : fallback;
    const prices = await counter.tierPrices([...new Set(ob.bill.lines.map((l) => l.itemId))], tier);
    const c = choice.customer;
    const err = change((x) =>
      setCustomer(
        x,
        { customer: c && { id: c.id, code: c.code, name: c.name }, walkinPhone: choice.walkinPhone },
        tier,
        prices,
      ),
    );
    if (err) return show(err);
    setDialog(null);
    setMessage(null);
    type(text, tier);
    focusSearch();
  };
  const openOnAccount = async () => {
    const ob = get();
    const id = ob?.customer?.id;
    if (!ob || !id || ob.bill.lines.length === 0 || maxDiscountBp === null || onAccountBlocked !== null)
      return;
    if (pendingApprovals(ob.bill, maxDiscountBp).length > 0) return setMessage(t('pay.approveFirst'));
    const s = await counter.checkout();
    setSettings(s);
    if (!s) return setMessage(t('pay.notReady'));
    setDialog({ kind: 'onAccount', figures: await counter.creditFigures(id, offline) });
  };
  const openClear = () => (get()?.bill.lines.length ?? 0) > 0 && setDialog({ kind: 'clear' });

  /** Hold (`F8`, POS spec §17): only a bill with lines, by someone who may hold. */
  const openHold = () => {
    if (!can(sellerGrants, 'pos.sale.hold', branchId)) return setMessage(t('hold.notPermitted'));
    if ((get()?.bill.lines.length ?? 0) === 0) return setMessage(t('hold.empty'));
    setDialog({ kind: 'hold' });
  };
  const holdNow = async (label: string | null): Promise<string | null> => {
    try {
      const held = await counter.holdBill({ userId: user.id, label });
      await clear();
      setDialog(null);
      setMessage(null);
      setNotice(t('hold.done', { name: held.label ?? held.bill.customer?.name ?? t('hold.walkin') }));
      await countHeld();
      focusSearch();
      return null;
    } catch (err) {
      if (err instanceof DomainError) return holdErrorKey(err.code);
      void counter.log('bill.hold_failed', { sellerId: user.id, error: String(err) });
      return 'hold.failed';
    }
  };
  const holdErrorKey = (code: DomainErrorCode) =>
    i18n.exists(`hold.error.${code}`) ? `hold.error.${code}` : errorKey(code);
  /** Recall (`Shift+F8`): one of the person's held bills becomes the open bill; a bill with lines is held first. */
  const recallHeld = async (held: HeldBill, swap: boolean): Promise<string | null> => {
    try {
      load(await counter.recallBill({ id: held.id, userId: user.id, swap: swap ? { label: null } : null }));
      setDialog(null);
      setMessage(null);
      setNotice(null);
      await countHeld();
      focusSearch();
      return null;
    } catch (err) {
      if (err instanceof DomainError) return holdErrorKey(err.code);
      void counter.log('bill.recall_failed', { sellerId: user.id, error: String(err) });
      return 'hold.failed';
    }
  };
  const clearHeldBill = async (held: HeldBill): Promise<string | null> => {
    await counter.clearHeld(held.id, user.id);
    await countHeld();
    return null;
  };
  const openRecall = () => setDialog({ kind: 'recall' });

  /** Void (`Alt+V`, POS spec §18): one of this counter's bills of today; the desk is asked first. */
  const openVoid = () => setDialog({ kind: 'void' });
  const voidList = useCallback((filter: string) => counter.voidableBills(filter), [counter]);
  const chooseVoid = async (bill: VoidListBill, answers: Answers = {}) => {
    const desk: DeskCheck =
      bill.cashDue === 0
        ? { status: 'not_applicable', at: null, cashierName: null }
        : await counter.deskCheck(bill.number);
    if (desk.status === 'received' || desk.status === 'paid_out') {
      setDialog(null);
      setMessage(
        desk.at === null
          ? t('void.handedOverHere', { number: bill.number })
          : t('void.handedOver', {
              number: bill.number,
              at: new Intl.DateTimeFormat(money.locale, {
                timeZone: tenantZone(),
                timeStyle: 'short',
              }).format(new Date(desk.at)),
              by: desk.cashierName ?? '',
            }),
      );
      return focusSearch();
    }
    askOrDecide(bill, desk, answers, 'void');
  };
  /**
   * The next payment part to ask about (W1-23, D-111), or the decision once every part is known: before a void, each
   * part that brings money in; before a return of an unpaid bill (guard 1), only its cash.
   */
  const askOrDecide = (bill: VoidListBill, desk: DeskCheck, answers: Answers, purpose: 'void' | 'return') => {
    const parts = paymentParts(bill.payments, desk.status).filter(
      (p) => purpose === 'void' || p.method === 'cash',
    );
    const part = parts.find((p) => p.known === null && answers[p.method] === undefined);
    if (part) return setDialog({ kind: 'paymentQuestion', bill, desk, part, answers, purpose });
    if (purpose === 'return') return returnOrVoidInstead(bill, desk, answers);
    const checks = answeredParts(paymentParts(bill.payments, desk.status), answers) ?? [];
    const d = voidOrReturn(checks);
    if (d.decision === 'void') return setDialog({ kind: 'voidApproval', bill, desk, answers });
    if (d.decision === 'return') {
      // The money has reached the shop: the refund must be recorded, which only a return does.
      returnCleared.current = bill.id;
      setNotice(t('void.moneyArrived', { number: bill.number }));
      return void openReturn(bill.id);
    }
    setDialog(null);
    setMessage(t('void.paymentMissing', { method: methodName(d.method), amount: m(d.amount) }));
    focusSearch();
  };
  const answerPayment = (arrived: boolean) => {
    if (dialog?.kind !== 'paymentQuestion') return;
    const answers: Answers = { ...dialog.answers, [dialog.part.method]: arrived ? 'arrived' : 'not_arrived' };
    askOrDecide(dialog.bill, dialog.desk, answers, dialog.purpose);
  };
  /** A bill cleared for a return by its payment answers: the return dialog doesn't ask again (W1-23). */
  const returnCleared = useRef<string | null>(null);
  /**
   * Guard 1 (W1-23, D-111), when the return dialog opens a bill: this counter's own cash bill of today that the desk
   * hasn't been paid for is voided and reissued instead. Another counter's bill goes on: only its own counter may
   * void it, and the desk keeps its refund until the bill is paid (guard 2). True to go on with the return.
   */
  const returnGuard = async (b: { id: string; number: string }): Promise<boolean> => {
    if (returnCleared.current === b.id) return true;
    const own = (await counter.voidableBills(b.number)).find((x) => x.id === b.id);
    if (!own || !own.payments.some((p) => p.method === 'cash' && p.amount > 0)) return true;
    const desk = await counter.deskCheck(own.number);
    if (desk.status === 'received' || desk.status === 'paid_out') return true;
    askOrDecide(own, desk, {}, 'return');
    return false;
  };
  const returnOrVoidInstead = (bill: VoidListBill, desk: DeskCheck, answers: Answers) => {
    const cash =
      paymentParts(bill.payments, desk.status).find((p) => p.method === 'cash')?.answer ??
      answers.cash ??
      null;
    const today = todayIs();
    if (returnWouldBeVoid({ payments: bill.payments, cash, billBusinessDate: today, today }))
      return setDialog({ kind: 'voidInstead', bill, desk, answers });
    returnCleared.current = bill.id;
    void openReturn(bill.id);
  };
  /** The approver's own PIN (`pos.void`, PLT-07), then the void in one local transaction, then the VOID print. */
  const attemptVoid = async (
    bill: VoidListBill,
    desk: DeskCheck,
    answers: Answers,
    ...[approver, pin, reason, note]: Parameters<ApprovalAttempt<VoidReason>>
  ): ReturnType<ApprovalAttempt<VoidReason>> => {
    const [before, grants] = await Promise.all([
      counter.getPinState(approver.id),
      counter.grants(approver.id),
    ]);
    const r = await checkVoidApprover({
      approver,
      approverState: before,
      approverGrants: grants,
      branchId: branchId ?? '',
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
    await counter.log(`void.${r.result}`, {
      userId: user.id,
      approverId: approver.id,
      number: bill.number,
    });
    if (r.result === 'approved') {
      try {
        const done = await counter.voidBill({
          userId: user.id,
          approverId: approver.id,
          saleId: bill.id,
          reason,
          note,
          deskStatus: desk.status,
          answers,
        });
        printDocument(done.sale, (await itemsOf(done.sale)).items, null, done.void);
        setMessage(null);
        setNotice(t('void.done', { number: bill.number, void: done.void.number }));
        onSaved?.();
        // A voided return isn't reissued: the return is started again with F3 (W1-13).
        if (done.sale.version === 1) setDialog({ kind: 'reissue', sale: done.sale });
        else {
          setDialog(null);
          focusSearch();
        }
      } catch (err) {
        setDialog(null);
        if (err instanceof DomainError) setMessage(t(voidErrorKey(err.code)));
        else {
          void counter.log('bill.void_failed', { number: bill.number, error: String(err) });
          setMessage(t('void.failed'));
        }
        focusSearch();
      }
    }
    return { result: r.result, failures: r.approverState.failures };
  };
  const voidErrorKey = (code: DomainErrorCode) =>
    i18n.exists(`void.error.${code}`) ? `void.error.${code}` : errorKey(code);
  /** Reissue (POS spec §18): the voided bill's customer, tier, lines and prices as the open bill, linked to it. */
  const reissue = async (sale: SaleDocument) => {
    setDialog(null);
    if ((get()?.bill.lines.length ?? 0) > 0) {
      setMessage(t('void.holdFirst', { number: sale.number }));
      return focusSearch();
    }
    const { found } = await itemsOf(sale);
    const bill = reissueBill({
      document: sale,
      sellerId: user.id,
      allowsFraction: Object.fromEntries(
        Object.entries(found).flatMap(([id, item]) => (item ? [[id, item.allowsFraction]] : [])),
      ),
      lineIds: sale.lines.map(() => uuidv7()),
    });
    const c = sale.customerId === null ? undefined : customers.find((x) => x.id === sale.customerId);
    const ob = {
      version: 1 as const,
      bill,
      items: Object.fromEntries(
        Object.entries(found).map(([id, item]) => [
          id,
          item
            ? { code: item.code, name: item.name, variant: item.variant, spec: item.spec }
            : { code: '', name: id, variant: null, spec: null },
        ]),
      ),
      customer:
        sale.customerId === null
          ? null
          : { id: sale.customerId, code: c?.code ?? '', name: c?.name ?? sale.customerId },
      walkinPhone: sale.walkinPhone,
      reissueOf: { id: sale.id, number: sale.number },
    };
    await counter.saveOpenBill(user.id, ob);
    load(ob);
    setNotice(t('void.reissuing', { number: sale.number }));
    focusSearch();
  };
  /** `F3` Return / exchange (POS spec §19): on an empty bill; a bill with lines is held first (F8). */
  const openReturn = async (billId?: string) => {
    const ob = get();
    if (!ob) return;
    if (ob.bill.lines.length > 0 || (ob.bill.returns ?? null) !== null) {
      setMessage(t('return.holdFirst'));
      return focusSearch();
    }
    const s = settings ?? (await counter.checkout());
    if (!s) return setMessage(t('pay.notReady'));
    const { windowDays } = await counter.returnPolicy([]);
    if (billId === undefined) setMessage(null);
    setDialog(billId === undefined ? { kind: 'return', windowDays } : { kind: 'return', windowDays, billId });
  };
  const todayIs = () => businessDate(nowMs(), settings?.timeZone ?? tenantZone(), settings?.cutoffHour ?? 4);

  /** Puts the returned lines on the bill, with the original bill's customer (POS spec §19). */
  const applyReturn = (
    choice: ReturnChoice,
    needs: ReturnApprovalKind[],
    approval: ReturnApprovalBy | null,
  ): string | null => {
    const source = choice.source;
    const customerId = source.kind === 'bill' ? source.customerId : null;
    const c = customerId === null ? undefined : customers.find((x) => x.id === customerId);
    const customer: BillCustomer | null =
      customerId === null ? null : { id: customerId, code: c?.code ?? '', name: c?.name ?? customerId };
    const err = change((ob) => {
      const r = tryEdit(ob, (b) => addReturn(b, { source, lines: choice.lines, needs, approval }));
      if (!r.ok) return r;
      return {
        ok: true as const,
        bill: {
          ...r.bill,
          items: { ...r.bill.items, ...choice.items },
          ...(source.kind === 'bill' ? { customer, walkinPhone: null } : {}),
        },
      };
    });
    if (err) return errorKey(err);
    setDialog(null);
    setNotice(null);
    setMessage(null);
    focusSearch();
    return null;
  };

  /** What the dialog chose: on the bill at once, or after an approval on the same screen (D-051, PLT-07). */
  const chooseReturn = async (choice: ReturnChoice): Promise<string | null> => {
    const ids = [...new Set(choice.lines.map((l) => l.itemId))];
    const policy = await counter.returnPolicy(ids);
    const check = returnNeeds({
      sellerGrants,
      branchId: branchId ?? '',
      original: choice.source.kind === 'bill' ? { businessDate: choice.source.businessDate } : null,
      today: todayIs(),
      windowDays: policy.windowDays,
      items: choice.lines.map((l) => policy.items[ids.indexOf(l.itemId)] ?? {}),
    });
    if (check.needs.length === 0) return applyReturn(choice, [], null);
    setDialog({ kind: 'returnApproval', choice, needs: check.needs });
    return null;
  };

  /** An approver's PIN for a return's needs, or for a refund by transfer (owner answer 1 to W1-13). */
  const attemptReturn = async (
    kinds: ReturnApprovalKind[],
    done: (by: ReturnApprovalBy) => Promise<void> | void,
    ...[approver, pin, reason, note]: Parameters<ApprovalAttempt<ReturnApprovalReason>>
  ): ReturnType<ApprovalAttempt<ReturnApprovalReason>> => {
    const [before, grants] = await Promise.all([
      counter.getPinState(approver.id),
      counter.grants(approver.id),
    ]);
    const r = await checkReturnApprover({
      approver,
      approverState: before,
      approverGrants: grants,
      branchId: branchId ?? '',
      kinds,
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
    await counter.log(`approval.return.${r.result}`, { sellerId: user.id, approverId: approver.id, kinds });
    if (r.result === 'approved')
      await done({ approvedBy: approver.id, reason, note, at: new Date().toISOString() });
    return { result: r.result, failures: r.approverState.failures };
  };

  const ignore = () => {};
  // F1, F3, F5 never reach the browser on the counter (no help page, find bar or reload mid-bill).
  useShortcuts(
    {
      F2: focusSearch,
      F4: () => void openCustomer(),
      F7: openTier,
      'Alt+C': openClear,
      'Alt+L': onLock,
      F9: payOrRefund,
      'Shift+F9': () => void openPay('split'),
      'Alt+P': () => setDialog({ kind: 'reprint' }),
      F8: openHold,
      'Shift+F8': openRecall,
      'Alt+V': openVoid,
      F1: ignore,
      F3: () => {
        returnCleared.current = null;
        void openReturn();
      },
      F5: ignore,
    },
    dialog === null,
  );

  const m = (minor: number) => formatMoney(minor, money);
  const nameOf = (id: string) =>
    staff.find((u) => u.id === id)?.fullName ?? (id === user.id ? user.fullName : id);
  const lineOf = (id: string) => openBill?.bill.lines.find((l) => l.id === id);

  const attempt =
    (p: PendingApproval): ApprovalAttempt<OverrideReason> =>
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

  /** The credit approval (POS spec §15): an approver with pos.credit.over_limit, then the bill is finalized. */
  const approveCredit = async (
    approver: StaffUser,
    pin: string,
    reason: CreditReason,
    note: string | null,
  ) => {
    if (dialog?.kind !== 'creditApproval') return { result: 'not_allowed' as const, failures: 0 };
    const { tender } = dialog;
    const [before, grants] = await Promise.all([
      counter.getPinState(approver.id),
      counter.grants(approver.id),
    ]);
    const r = await checkCreditApprover({
      approver,
      approverState: before,
      approverGrants: grants,
      branchId,
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
    await counter.log(`approval.credit.${r.result}`, { sellerId: user.id, approverId: approver.id });
    if (r.result === 'approved') {
      const problem = await pay(tender, {
        requestedBy: user.id,
        approvedBy: approver.id,
        reason,
        note,
        at: new Date().toISOString(),
      });
      if (problem) {
        setDialog(null);
        setMessage(t(problem));
      }
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
    {
      keys: 'F9',
      label: padMode === 'refund' ? t('keys.refund') : padMode === 'even' ? t('keys.even') : t('keys.pay'),
      run: payOrRefund,
    },
    {
      keys: 'F3',
      label: t('keys.return'),
      run: () => {
        returnCleared.current = null;
        void openReturn();
      },
    },
    { keys: 'F4', label: t('keys.customer'), run: () => void openCustomer() },
    { keys: 'F7', label: t('keys.tier'), run: openTier },
    { keys: 'F8', label: t('keys.hold'), run: openHold },
    {
      keys: 'Shift+F8',
      label: heldCount > 0 ? t('keys.recallCount', { count: heldCount }) : t('keys.recall'),
      run: openRecall,
    },
    { keys: 'Alt+C', label: t('keys.clearBill'), run: openClear },
    { keys: 'Alt+P', label: t('keys.reprint'), run: () => setDialog({ kind: 'reprint' }) },
    { keys: 'Alt+V', label: t('keys.void'), run: openVoid },
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
          customerText={
            customerRow
              ? customerStrip(customerRow, t, m)
              : billCustomer
                ? `${billCustomer.name} (${billCustomer.code})`
                : null
          }
          walkinPhone={openBill?.walkinPhone ?? null}
          reissueOf={openBill?.reissueOf?.number ?? null}
          selected={lineSel}
          active={zone === 'bill'}
          message={saveFailed ? t('bill.saveFailed') : message}
          notice={notice}
          money={money}
          nameOf={nameOf}
          pad={
            <PaymentPad
              methods={settings?.methods ?? []}
              disabled={lines.length === 0 && returns === null}
              mode={padMode}
              onRefund={openRefund}
              refundAccountBlocked={refundAccountBlocked}
              onEven={() => setDialog({ kind: 'even' })}
              onCash={() => void openPay('cash')}
              onMethod={(method) => void openPay(method)}
              onAccount={() => void openOnAccount()}
              onAccountBlocked={onAccountBlocked}
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
          creditCustomer={onAccountBlocked === null}
          onPay={pay}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'hold' && (
        <HoldDialog lineCount={lines.length} onHold={holdNow} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'recall' && (
        <RecallDialog
          list={heldList}
          billHasLines={lines.length > 0}
          money={money}
          timeZone={tenantZone()}
          onRecall={recallHeld}
          onClear={clearHeldBill}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'void' && (
        <VoidDialog
          list={voidList}
          money={money}
          timeZone={tenantZone()}
          sellerName={nameOf}
          onChoose={chooseVoid}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'voidApproval' && (
        <ApprovalDialog<VoidReason>
          description={
            dialog.desk.status === 'unknown'
              ? t('void.approveAsked', { number: dialog.bill.number })
              : t('void.approve', { number: dialog.bill.number })
          }
          facts={[
            [t('void.bill'), dialog.bill.number],
            [t('void.total'), m(dialog.bill.total)],
            [t('approval.seller'), nameOf(dialog.bill.sellerId)],
            [t('void.desk'), t(`void.deskStatus.${dialog.desk.status}`)],
            // What was answered (W1-23): the approver sees it before entering their PIN.
            ...Object.entries(dialog.answers).map(
              ([method, a]) =>
                [t('void.answered', { method: methodName(method) }), t(`void.answer.${a}`)] as [
                  string,
                  ReactNode,
                ],
            ),
          ]}
          staff={staff}
          reasons={VOID_REASONS}
          onApprove={(...args) => attemptVoid(dialog.bill, dialog.desk, dialog.answers, ...args)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'paymentQuestion' &&
        (dialog.part.method === 'cash' ? (
          <PaymentQuestionDialog
            title={t('void.ask.cashTitle')}
            question={t('void.ask.cash', { number: dialog.bill.number })}
            help={t('void.ask.cashHelp')}
            facts={[
              [t('void.bill'), dialog.bill.number],
              [t('void.ask.cashDue'), m(dialog.part.amount)],
            ]}
            yes={t('void.ask.cashYes')}
            no={t('void.ask.cashNo')}
            onAnswer={answerPayment}
            onClose={() => setDialog(null)}
          />
        ) : (
          <PaymentQuestionDialog
            title={t('void.ask.accountTitle')}
            question={t('void.ask.account', {
              method: methodName(dialog.part.method),
              amount: m(dialog.part.amount),
              number: dialog.bill.number,
            })}
            help={t('void.ask.accountHelp')}
            facts={[
              [t('void.bill'), dialog.bill.number],
              [methodName(dialog.part.method), m(dialog.part.amount)],
            ]}
            yes={t('void.ask.accountYes')}
            no={t('void.ask.accountNo')}
            onAnswer={answerPayment}
            onClose={() => setDialog(null)}
          />
        ))}
      {dialog?.kind === 'voidInstead' && (
        <ConfirmDialog
          title={t('return.unpaidTitle', { number: dialog.bill.number })}
          body={t('return.unpaid', { number: dialog.bill.number })}
          actionLabel={t('return.voidInstead')}
          onConfirm={() => void chooseVoid(dialog.bill, dialog.answers)}
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
        />
      )}
      {dialog?.kind === 'reissue' && (
        <ConfirmDialog
          title={t('void.reissueTitle', { number: dialog.sale.number })}
          body={t('void.reissueBody')}
          actionLabel={t('void.reissueAction')}
          onConfirm={() => void reissue(dialog.sale)}
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
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
          description={t(`approval.${dialog.pending.need}`)}
          facts={approvalFacts(dialog.pending)}
          staff={staff}
          onApprove={attempt(dialog.pending)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'customer' && (
        <CustomerDialog
          customers={customers}
          tiers={tiers}
          current={billCustomer}
          walkinPhone={openBill?.walkinPhone ?? null}
          money={money}
          onChoose={(choice) => void chooseCustomer(choice)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'onAccount' && total && billCustomer && (
        <OnAccountDialog
          total={total.total}
          money={money}
          customerName={billCustomer.name}
          figures={dialog.figures}
          timeZone={tenantZone()}
          onPay={pay}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'return' && (
        <ReturnDialog
          counter={counter}
          money={money}
          timeZone={tenantZone()}
          windowDays={dialog.windowDays}
          today={todayIs()}
          {...(dialog.billId === undefined ? {} : { initialBillId: dialog.billId })}
          beforeOpen={returnGuard}
          onChoose={chooseReturn}
          onClose={() => {
            setDialog(null);
            focusSearch();
          }}
        />
      )}
      {dialog?.kind === 'returnApproval' && (
        <ApprovalDialog<ReturnApprovalReason>
          description={dialog.needs.map((n) => t(`return.need.${n}`)).join(' ')}
          facts={[
            [
              t('return.from'),
              dialog.choice.source.kind === 'bill' ? dialog.choice.source.number : t('return.noReceiptShort'),
            ],
            ...dialog.choice.lines.map(
              (l) =>
                [
                  dialog.choice.items[l.itemId]?.name ?? l.itemId,
                  l.price === null
                    ? `×${formatQty(l.qty, money.locale)}`
                    : t('return.priceFact', {
                        qty: formatQty(l.qty, money.locale),
                        price: m(l.price),
                        suggested: l.suggested === null ? '–' : m(l.suggested),
                      }),
                ] as [string, ReactNode],
            ),
            [t('approval.seller'), user.fullName],
          ]}
          staff={staff}
          reasons={RETURN_APPROVAL_REASONS}
          onApprove={(...args) =>
            attemptReturn(
              dialog.needs,
              (by) => {
                const problem = applyReturn(dialog.choice, dialog.needs, by);
                if (problem) {
                  setDialog(null);
                  setMessage(t(problem));
                }
              },
              ...args,
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'refund' && settings && total && (
        <RefundDialog
          to={dialog.to}
          settings={settings}
          total={total.total}
          money={money}
          customerName={customerRow?.name ?? null}
          onPay={(tender) => {
            // A refund by transfer is approved by a manager first (owner answer 1 to W1-13).
            if (dialog.to === 'transfer') {
              setDialog({ kind: 'refundApproval', tender });
              return Promise.resolve(null);
            }
            return pay(tender);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'refundApproval' && (
        <ApprovalDialog<ReturnApprovalReason>
          description={t('return.need.refund_transfer')}
          facts={[
            [t('refund.amount'), m(negate(dialog.tender.payments[0]?.amount ?? toMoney(0)))],
            [t('refund.method'), methodName(dialog.tender.payments[0]?.method ?? '')],
            [t('approval.seller'), user.fullName],
          ]}
          staff={staff}
          reasons={RETURN_APPROVAL_REASONS}
          onApprove={(...args) =>
            attemptReturn(
              ['refund_transfer'],
              async (by) => {
                const problem = await pay(dialog.tender, null, by);
                if (problem) {
                  setDialog(null);
                  setMessage(t(problem));
                }
              },
              ...args,
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'even' && (
        <ConfirmDialog
          title={t('refund.evenTitle')}
          body={t('refund.evenBody')}
          actionLabel={t('pay.finalize')}
          onConfirm={() => {
            void pay({ payments: [], cashReceived: null }).then((problem) => {
              if (problem) {
                setDialog(null);
                setMessage(t(problem));
              }
            });
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'creditApproval' && (
        <ApprovalDialog
          description={dialog.needs.map((n) => t(`approval.${n}`)).join(' ')}
          facts={[
            [t('approval.customer'), billCustomer?.name ?? ''],
            ...(dialog.overLimitBy > 0
              ? [[t('approval.overLimit'), m(dialog.overLimitBy)] as [string, ReactNode]]
              : []),
            ...(dialog.overCapBy > 0
              ? [[t('approval.overCap'), m(dialog.overCapBy)] as [string, ReactNode]]
              : []),
            [t('approval.seller'), user.fullName],
          ]}
          staff={staff}
          reasons={CREDIT_REASONS}
          onApprove={approveCredit}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
