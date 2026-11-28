import type { BillNoLookup, DocumentRow, PurchasingLookups, ReceiptView } from '@erp/contracts';
import { amountLimit, billNoKey, checkReceipt, isEmptyDraft, receiptTotals } from '@erp/domain';
import {
  formatMoney,
  PageHeader,
  Panel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@erp/ui';
import { CircleAlert, Plus, Save, Send, Tag, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyText, moneyValue, qtyText, qtyValue } from '../catalog/data';
import { href, navigate, takeCarried } from '../router';
import {
  ActionBar,
  Button,
  buttonClass,
  ConfirmDialog,
  IconButton,
  ListPicker,
  notify,
  Select,
  TextInput,
  useOneAtATime,
} from '../ui';
import { ItemPicker } from './ItemPicker';
import {
  dateProblem,
  problemText,
  purchasingRefusal,
  shortProblemText,
  usePurchasingLookups,
  type PickedItem,
} from './data';
import {
  HEAD_FIELD,
  LineBox,
  lineFieldOf,
  useFocusNewLine,
  useShownProblems,
  type LineField,
  type LineNote,
} from './lineFields';

// Goods receipts (W1-16, PUR-02): the list, and one receipt typed from the supplier's bill. As you type, the screen
// checks it with the same rules as the server: the difference from the bill total as printed (posting waits until
// it is 0), the line problems, and the warnings (a cost more than 10 % off the last one, Retail at or below the new
// cost). Save keeps a draft; Post makes it final (rule 3). Paid in cash: the cashier pays it at the desk afterwards
// (owner answer 1). W2-14 (D-127): the back office's own controls; the supplier is searched (owner answer 3), and
// results and refusals are toasts (owner answer 6). W2-16 (owner's review, 2026-11-28): laid out like the paper bill
// (its head at the top, its discount and total at the foot), each problem under its own field, a # column, Enter on
// the last line adds one, the last cost under the unit cost, and the totals with Save and Post in a bar kept at the
// bottom of the window; Post stays clickable and marks what is left to fix. W2-17 (owner's staging test): no amount
// over Rs 1 crore (owner answer 1); a box that can't be read is never 0 and can't be saved; Save draft marks nothing
// red but says what is left (owner answer 2); one save at a time; short words under a line's boxes. W2-18: a
// supplier's bill is posted once: the bill number says which receipt already has it, or that another draft does.

export function ReceiptsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [list, setList] = useState<DocumentRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/purchasing/receipts').then(
      (r) => live && setList(r.status === 200 ? (r.body as { receipts: DocumentRow[] }).receipts : []),
    );
    return () => {
      live = false;
    };
  }, [api]);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader
        title={t('purchasing.receipts.title')}
        help={t('purchasing.receipts.help')}
        actions={
          lookups.can.receive && (
            <a href={href.receipt('new')} className={buttonClass()}>
              <Plus aria-hidden="true" className="size-4" />
              {t('purchasing.receipts.add')}
            </a>
          )
        }
      />
      <DocumentList
        list={list}
        lookups={lookups}
        link={href.receipt}
        label={t('purchasing.receipts.title')}
      />
    </>
  );
}

export function DocumentList({
  list,
  lookups,
  link,
  label,
}: {
  list: DocumentRow[] | null;
  lookups: PurchasingLookups;
  link: (id: string) => string;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <Panel className="overflow-x-auto px-1.5 pb-2.5">
      {list === null ? (
        <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
      ) : list.length === 0 ? (
        <p className="p-2 text-muted-foreground">{t('purchasing.receipts.empty')}</p>
      ) : (
        <Table aria-label={label}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('purchasing.fields.number')}</TableHead>
              <TableHead>{t('purchasing.fields.supplier')}</TableHead>
              <TableHead>{t('purchasing.fields.date')}</TableHead>
              <TableHead>{t('purchasing.fields.billNo')}</TableHead>
              <TableHead className="text-end">{t('purchasing.fields.amount')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <a
                    href={link(d.id)}
                    className="font-mono font-semibold text-ink underline-offset-4 hover:underline"
                  >
                    {d.number ?? t('purchasing.draft')}
                  </a>
                  {d.status === 'draft' && (
                    <span className="ms-2 inline-block">
                      <StatusChip tone="warn">{t('purchasing.draft')}</StatusChip>
                    </span>
                  )}
                </TableCell>
                <TableCell>{d.supplierName ?? '—'}</TableCell>
                <TableCell>{d.date}</TableCell>
                <TableCell>{d.billNo ?? '—'}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {d.amount === null ? '—' : formatMoney(d.amount, lookups.money)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

interface LineForm {
  item:
    | PickedItem
    | {
        id: string | null;
        code: string | null;
        name: string | null;
        allowsFraction: boolean;
        lastCost: number | null;
        retail: number | null;
      };
  qty: string;
  unitCost: string;
  lineDiscount: string;
}

/** "Paid from": on account, as an option (a dropdown's option can't be empty). */
const ON_ACCOUNT = 'account';

const blankLine = (): LineForm => ({
  item: { id: null, code: null, name: null, allowsFraction: false, lastCost: null, retail: null },
  qty: '',
  unitCost: '',
  lineDiscount: '',
});

export function ReceiptScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [view, setView] = useState<ReceiptView | null | undefined>(id === 'new' ? null : undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (id === 'new') return;
    let live = true;
    void api('GET', `/api/purchasing/receipts/${encodeURIComponent(id)}`).then(
      (r) => live && setView(r.status === 200 ? (r.body as ReceiptView) : null),
    );
    return () => {
      live = false;
    };
  }, [api, id, version]);
  const load = () => {
    setVersion((v) => v + 1);
    return Promise.resolve();
  };

  const back = (
    <a
      href={href.receipts}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('purchasing.receipts.title')}
    </a>
  );
  if (lookups === null || view === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (view === null && id !== 'new')
    return <PageHeader eyebrow={back} title={t('purchasing.receipts.notFound')} />;
  return (
    <ReceiptForm
      key={view?.receipt.rowVersion ?? 'new'}
      api={api}
      lookups={lookups}
      view={view}
      back={back}
      onSaved={load}
    />
  );
}

function ReceiptForm({
  api,
  lookups,
  view,
  back,
  onSaved,
}: {
  api: Api;
  lookups: PurchasingLookups;
  view: ReceiptView | null;
  back: ReactNode;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const m = lookups.money;
  // No amount over Rs 1 crore, in the shop's money (W2-17, owner answer 1).
  const limit = amountLimit(m.minorUnits);
  const limitText = formatMoney(limit, m);
  const r = view?.receipt;
  const posted = r?.status === 'posted';
  const can = lookups.can.receive && !posted;
  const shop = lookups.locations.find((l) => l.code === 'SHOP')?.id ?? lookups.locations[0]?.id ?? '';
  const [h, setH] = useState({
    supplierId: r?.supplierId ?? '',
    billNo: r?.billNo ?? '',
    billDate: r?.billDate ?? lookups.today,
    receivedOn: r?.receivedOn ?? lookups.today,
    locationId: r?.locationId ?? shop,
    paidFrom: r?.paidFrom ?? '',
    billTotal: moneyText(r?.billTotal ?? null, m.minorUnits),
    billDiscount: r && r.billDiscount > 0 ? moneyText(r.billDiscount, m.minorUnits) : '',
    notes: r?.notes ?? '',
  });
  const [lines, setLines] = useState<LineForm[]>(
    view && view.lines.length > 0
      ? view.lines.map((l) => ({
          item: {
            id: l.itemId,
            code: l.code,
            name: l.name,
            allowsFraction: l.allowsFraction,
            lastCost: l.lastCost,
            retail: l.retail,
          },
          qty: qtyText(l.qty),
          unitCost: moneyText(l.unitCost, m.minorUnits),
          lineDiscount: l.lineDiscount > 0 ? moneyText(l.lineDiscount, m.minorUnits) : '',
        }))
      : [blankLine()],
  );
  // A refusal from just before this form opened (a new draft at its own address, or a reload): see `carry`. It is a
  // toast, as any refusal (owner answer 6).
  // Who else has this supplier's bill (W2-18): asked when the bill number is left, when the supplier changes, and
  // when a draft opens; never while typing. Only the latest answer counts.
  const [billCheck, setBillCheck] = useState<(BillNoLookup & { opened?: boolean }) | null>(null);
  const asked = useRef(0);
  const askBill = (supplierId: string, billNo: string) => {
    const n = ++asked.current;
    if (!supplierId || billNoKey(billNo) === '') {
      setBillCheck(null);
      return;
    }
    const q = new URLSearchParams({ supplier: supplierId, billNo, ...(r ? { except: r.id } : {}) });
    void api('GET', `/api/purchasing/receipts/bill-no?${q.toString()}`).then((res) => {
      if (n === asked.current && res.status === 200) setBillCheck(res.body as BillNoLookup);
    });
  };
  useEffect(() => {
    if (!r || r.status === 'posted' || !r.supplierId || billNoKey(r.billNo ?? '') === '') return;
    let live = true;
    const q = new URLSearchParams({ supplier: r.supplierId, billNo: r.billNo ?? '', except: r.id });
    void api('GET', `/api/purchasing/receipts/bill-no?${q.toString()}`).then((res) => {
      // A saved draft whose bill is already posted says so at once: nothing left to type would change it.
      if (live && res.status === 200) setBillCheck({ ...(res.body as BillNoLookup), opened: true });
    });
    return () => {
      live = false;
    };
  }, [api, r]);
  const [carried] = useState(() => takeCarried(href.receipt(r?.id ?? 'new')));
  useEffect(() => {
    if (carried !== null) notify.problem(carried);
  }, [carried]);
  const set = (k: keyof typeof h, v: string) => setH((x) => ({ ...x, [k]: v }));
  const put = (n: number, patch: Partial<LineForm>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const form = useRef<HTMLDivElement>(null);
  const problems = useShownProblems(form);
  // A line added with Enter gets the cursor in its item (W2-16).
  const lineId = useId();
  const itemFieldId = (i: number) => `${lineId}-item-${i}`;
  const focusLater = useFocusNewLine(lines.length, itemFieldId);
  const addLine = (focus: boolean) => {
    setLines((ls) => [...ls, blankLine()]);
    if (focus) focusLater(lines.length);
  };

  // The same check as the server's, as you type (a field that isn't a number counts as an invalid one).
  // Empty counts as 0, not a number as NaN (an invalid value for the check).
  const n = (v: number | null | undefined) => (v === undefined ? Number.NaN : (v ?? 0));
  // A line not filled in yet (no item, nothing typed) is not checked, totalled or saved: just a line to come.
  const blank = (l: LineForm) =>
    l.item.id === null && l.qty.trim() === '' && l.unitCost.trim() === '' && l.lineDiscount.trim() === '';
  const used = lines.flatMap((l, i) => (blank(l) ? [] : [i]));
  /** The checked row of displayed line `i`, or -1 for a line not filled in yet. */
  const rowOf = (i: number) => used.indexOf(i);
  const parsed = used
    .map((i) => lines[i]!)
    .map((l) => ({
      itemId: l.item.id,
      qty: n(qtyValue(l.qty)),
      unitCost: n(moneyValue(l.unitCost, m.minorUnits)),
      // A discount that can't be read is a problem, never 0 (W2-17); an empty one is 0.
      lineDiscount: n(moneyValue(l.lineDiscount, m.minorUnits)),
      allowsFraction: l.item.allowsFraction,
      lastCost: posted ? null : l.item.lastCost,
      retail: l.item.retail,
    }));
  const billTotal = moneyValue(h.billTotal, m.minorUnits);
  // A date after the shop's business date (W2-05) or on or before the lock date (D-108) can't post: the date says why,
  // and Post marks it. Save draft still works.
  const locked = dateProblem(t, h.receivedOn, lookups);
  const check = checkReceipt({
    supplierId: h.supplierId || null,
    billNo: h.billNo,
    billDate: h.billDate || null,
    locationId: h.locationId || null,
    billDiscount: n(moneyValue(h.billDiscount, m.minorUnits)),
    billTotal: billTotal === undefined ? null : billTotal,
    maxAmount: limit,
    billNoPostedAs: billCheck?.posted?.number ?? null,
    lines: parsed.map((p) => ({
      ...p,
      qty: p.qty ?? 0,
      unitCost: p.unitCost ?? 0,
    })),
  });
  const totals =
    check.total === null
      ? null
      : receiptTotals({
          lines: parsed.map((p) => ({
            qty: p.qty ?? 0,
            unitCost: p.unitCost ?? 0,
            lineDiscount: p.lineDiscount,
          })),
          billDiscount: n(moneyValue(h.billDiscount, m.minorUnits)),
        });
  const show = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, m));
  const exists = (k: string) => t(k) !== k;
  const toFix = check.problems.length + (locked === null ? 0 : 1);

  // A box whose text isn't a number (W2-17): its problem says so, and Save draft can't keep it.
  const unreadable = (text: string, value: number | null | undefined) =>
    text.trim() !== '' && value === undefined;
  const lineUnreadable = (i: number, field: LineField) => {
    const l = lines[i]!;
    if (field === 'qty') return unreadable(l.qty, qtyValue(l.qty));
    if (field === 'unitCost') return unreadable(l.unitCost, moneyValue(l.unitCost, m.minorUnits));
    if (field === 'discount') return unreadable(l.lineDiscount, moneyValue(l.lineDiscount, m.minorUnits));
    return false;
  };
  const headUnreadable = (field: 'billDiscount' | 'billTotal') =>
    unreadable(h[field], moneyValue(h[field], m.minorUnits));

  // Each problem under its own field, once the field is left or Post is pressed (W2-16, W2-17).
  const headProblem = (field: string) => {
    if (!problems.shown(field)) return undefined;
    if ((field === 'billDiscount' || field === 'billTotal') && headUnreadable(field))
      return t('purchasing.problems.not_amount');
    const p = check.problems.filter((x) => x.row === null && HEAD_FIELD[x.problem] === field);
    return p.length === 0
      ? undefined
      : p.map((x) => problemText(t, exists, x.problem, null, limitText)).join(' ');
  };
  // Under the bill number: the receipt that already has this supplier's bill, as a link to it (W2-18).
  const billNoProblem = (): ReactNode => {
    const taken = billCheck?.posted;
    const shown = problems.shown('billNo') || billCheck?.opened === true;
    if (taken && shown && check.problems.some((x) => x.problem === 'bill_no_taken')) {
      const mark = '\u2063';
      const [before = '', after = ''] = t('purchasing.problems.bill_no_taken', { number: mark }).split(mark);
      return (
        <>
          {before}
          <a href={href.receipt(taken.id)} className="font-mono underline underline-offset-4">
            {taken.number}
          </a>
          {after}
        </>
      );
    }
    return headProblem('billNo');
  };
  // Under a line's box, the short words (W2-17).
  const lineProblem = (i: number, field: LineField) => {
    if (rowOf(i) < 0 || !problems.shown(`${i}:${field}`)) return undefined;
    if (lineUnreadable(i, field))
      return t(`purchasing.short.${field === 'qty' ? 'not_number' : 'not_amount'}`);
    const p = check.problems.filter((x) => x.row === rowOf(i) && lineFieldOf(x.problem) === field);
    return p.length === 0
      ? undefined
      : p.map((x) => shortProblemText(t, exists, x.problem, limitText)).join(' ');
  };
  /** The boxes Save draft can't keep (W2-17): text that isn't a number, and any amount over the limit. */
  const unsaveable = () => {
    const keys: string[] = [];
    lines.forEach((_, i) => {
      if (rowOf(i) < 0) return;
      for (const f of ['qty', 'unitCost', 'discount'] as const)
        if (lineUnreadable(i, f)) keys.push(`${i}:${f}`);
    });
    for (const f of ['billDiscount', 'billTotal'] as const) if (headUnreadable(f)) keys.push(f);
    for (const x of check.problems)
      if (x.problem.endsWith('_too_large'))
        keys.push(
          x.row === null
            ? (HEAD_FIELD[x.problem] ?? 'billTotal')
            : `${used[x.row]}:${lineFieldOf(x.problem)}`,
        );
    return keys;
  };
  // Under the unit cost: the last cost, amber with how far it moved when more than 10 %; Retail when the new cost
  // reaches it. Warnings never stop Post.
  const costNotes = (i: number, l: LineForm): LineNote[] => {
    if (posted) return [];
    const w = rowOf(i) < 0 ? [] : check.warnings.filter((x) => x.row === rowOf(i)).map((x) => x.warning);
    const notes: LineNote[] = [];
    const last = l.item.lastCost;
    if (last !== null) {
      const cost = moneyValue(l.unitCost, m.minorUnits);
      const pct = typeof cost === 'number' && last > 0 ? Math.round((Math.abs(cost - last) * 100) / last) : 0;
      const moved = w.includes('cost_up') ? 'lastUp' : w.includes('cost_down') ? 'lastDown' : null;
      notes.push({
        text: t(`purchasing.line.${moved ?? 'last'}`, {
          cost: formatMoney(last, m),
          pct,
        }),
        warn: moved !== null,
      });
    }
    if (w.includes('retail_at_or_below_cost') && l.item.retail !== null)
      notes.push({
        text: t('purchasing.line.retailLow', {
          retail: formatMoney(l.item.retail, m),
        }),
        warn: true,
      });
    return notes;
  };

  const body = () => ({
    supplierId: h.supplierId || null,
    billNo: h.billNo,
    billDate: h.billDate || null,
    receivedOn: h.receivedOn,
    locationId: h.locationId,
    paidFrom: h.paidFrom || null,
    billDiscount: moneyValue(h.billDiscount, m.minorUnits) ?? 0,
    billTotal: typeof billTotal === 'number' ? billTotal : null,
    notes: h.notes,
    lines: parsed.map((p) => ({
      itemId: p.itemId,
      qty: Number.isFinite(p.qty) ? p.qty : 0,
      unitCost: Number.isFinite(p.unitCost) ? p.unitCost : 0,
      lineDiscount: Number.isFinite(p.lineDiscount) ? p.lineDiscount : 0,
    })),
  });

  /** Saves the draft; returns its id and row version, or null after showing why not. */
  const save = async (): Promise<{ id: string; rowVersion: string } | null> => {
    // A box that can't be read, or an amount over the limit, can't be kept: only those are marked (W2-17).
    const bad = unsaveable();
    if (bad.length > 0) {
      problems.mark(bad);
      notify.problem(t('purchasing.cantSave'));
      return null;
    }
    // Nothing on any line is nothing to keep (owner's review of W1-19); the server refuses it too.
    if (isEmptyDraft(body().lines)) {
      notify.problem(t('purchasing.errors.empty_draft'));
      return null;
    }
    const res = r
      ? await api('PUT', `/api/purchasing/receipts/${encodeURIComponent(r.id)}`, {
          ...body(),
          rowVersion: r.rowVersion,
        })
      : await api('POST', '/api/purchasing/receipts', body());
    if (res.status === 200)
      return {
        id: r!.id,
        rowVersion: (res.body as { rowVersion: string }).rowVersion,
      };
    if (res.status === 201) return res.body as { id: string; rowVersion: string };
    notify.problem(purchasingRefusal(t, exists, res.body, m));
    return null;
  };
  // One save at a time (W2-17): each action says whether its form is about to be replaced (true), so the buttons stay
  // busy until the new version is on the screen.
  const act = useOneAtATime<'save' | 'post' | 'delete'>();
  // A draft may be incomplete: Save draft keeps it, marks nothing, and says what is left before posting (W2-17, owner
  // answer 2).
  const saveDraft = async () => {
    const s = await save();
    if (!s) return false;
    notify.done(toFix > 0 ? t('purchasing.savedToFix', { count: toFix }) : t('purchasing.receipts.saved'));
    if (!r) navigate(href.receipt(s.id));
    else await onSaved();
    return true;
  };
  // Post stays clickable (W2-16): with problems it sends nothing, marks them all and puts the cursor on the first.
  const postIt = async () => {
    if (toFix > 0) {
      problems.focusFirst();
      return false;
    }
    const s = await save();
    if (!s) return false;
    const res = await api('POST', `/api/purchasing/receipts/${encodeURIComponent(s.id)}/post`, {
      rowVersion: s.rowVersion,
    });
    if (res.status === 200) {
      if (!r) navigate(href.receipt(s.id));
      else await onSaved();
      return true;
    }
    // The draft was saved before Post was refused: open it again, as saved, with the refusal.
    const text = purchasingRefusal(t, exists, res.body, m);
    // A new draft opens at its own address and shows it there; a toast outlives this form's reload.
    if (!r) navigate(href.receipt(s.id), text);
    else {
      notify.problem(text);
      await onSaved();
    }
    return true;
  };
  // Delete asks first (W2-16 point 7): a typed-in bill is a lot to lose to a misclick.
  const [asking, setAsking] = useState(false);
  const remove = async () => {
    if (!r) return false;
    const res = await api('DELETE', `/api/purchasing/receipts/${encodeURIComponent(r.id)}`);
    if (res.status === 200) {
      notify.done(t('purchasing.deleted'));
      navigate(href.receipts);
      return true;
    }
    notify.problem(purchasingRefusal(t, exists, res.body, m));
    return false;
  };

  const difference =
    check.difference === null
      ? '—'
      : check.difference === 0
        ? t('purchasing.totals.matches')
        : show(check.difference);
  const differenceTone = check.difference === null ? '' : check.difference === 0 ? 'text-ok' : 'text-bad';
  const linesProblem = headProblem('lines');

  return (
    <div ref={form} className="contents">
      <PageHeader
        eyebrow={back}
        title={
          r?.number ?? (
            <>
              {t('purchasing.receipts.new')}
              {r && (
                <span className="ms-2.5 inline-block align-middle text-base">
                  <StatusChip tone="warn">{t('purchasing.draft')}</StatusChip>
                </span>
              )}
            </>
          )
        }
        help={
          posted ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip tone="ok">{t('purchasing.posted')}</StatusChip>
              {t('purchasing.receipts.due', { date: r?.dueDate ?? '' })}
            </span>
          ) : (
            t('purchasing.receipts.editHelp')
          )
        }
        actions={
          posted &&
          r && (
            <span className="flex flex-wrap gap-2">
              {/* W1-17: the received pieces' labels (CAT-08), by the receipt's number, which the labels page shows
                  in its field (W2-16 point 8); a posted receipt has one. */}
              <a href={href.receiptLabels(r.number ?? r.id)} className={buttonClass('outline')}>
                <Tag aria-hidden="true" className="size-4" />
                {t('labels.makeLabels')}
              </a>
              <a href={href.purchaseReturn(`new-${r.id}`)} className={buttonClass('outline')}>
                <Undo2 aria-hidden="true" className="size-4" />
                {t('purchasing.returns.fromReceipt')}
              </a>
            </span>
          )
        }
      />

      {/* The head of the bill, in the order it is printed (W2-16). */}
      <Panel role="region" aria-labelledby={`${lineId}-bill`}>
        <h2 id={`${lineId}-bill`} className="m-0 px-3.5 pt-3.5 text-[15px] font-semibold">
          {t('purchasing.receipts.bill')}
        </h2>
        <fieldset disabled={!can} className="m-0 grid grid-cols-1 gap-3.5 border-0 p-3.5 md:grid-cols-4">
          <div className="md:col-span-2" onBlur={problems.touch('supplier')}>
            <ListPicker
              label={t('purchasing.fields.supplier')}
              options={lookups.suppliers}
              value={h.supplierId}
              onChange={(v) => {
                set('supplierId', v);
                // The same bill number may be another supplier's (W2-18): ask again for this one.
                askBill(v, h.billNo);
              }}
              error={headProblem('supplier')}
            />
          </div>
          <TextInput
            label={t('purchasing.fields.billNo')}
            value={h.billNo}
            error={billNoProblem()}
            hint={
              billCheck && !billCheck.posted && billCheck.drafts > 0 ? (
                <span className="font-medium text-warn">{t('purchasing.warnings.bill_no_on_draft')}</span>
              ) : undefined
            }
            onBlur={() => {
              problems.touch('billNo')();
              askBill(h.supplierId, h.billNo);
            }}
            onChange={(e) => {
              set('billNo', e.target.value);
              // An answer about the number before this one no longer holds; asked again when the field is left.
              asked.current++;
              setBillCheck(null);
            }}
          />
          <TextInput
            label={t('purchasing.fields.billDate')}
            type="date"
            value={h.billDate}
            error={headProblem('billDate')}
            onBlur={problems.touch('billDate')}
            onChange={(e) => set('billDate', e.target.value)}
          />
          <TextInput
            label={t('purchasing.fields.receivedOn')}
            type="date"
            error={locked}
            max={lookups.today}
            value={h.receivedOn}
            onChange={(e) => set('receivedOn', e.target.value)}
          />
          <Select
            label={t('purchasing.fields.location')}
            disabled={!can}
            value={h.locationId}
            error={headProblem('location')}
            onValueChange={(v) => set('locationId', v)}
            options={lookups.locations
              .filter((l) => l.code !== 'DAMAGED')
              .map((l) => ({ value: l.id, label: l.name }))}
          />
          {/* Paid in cash: on the supplier's account, paid at the desk afterwards (owner answer 1). Said in the
              list, where someone looking for Cash looks, not on every receipt (owner, 2026-11-28). */}
          <Select
            label={t('purchasing.fields.paid')}
            wrapperClassName="md:col-span-2"
            disabled={!can}
            value={h.paidFrom || ON_ACCOUNT}
            onValueChange={(v) => set('paidFrom', v === ON_ACCOUNT ? '' : v)}
            note={t('purchasing.receipts.cashNote')}
            options={[
              { value: ON_ACCOUNT, label: t('purchasing.receipts.onAccount') },
              ...lookups.bankAccounts.map((b) => ({
                value: b.id,
                label: t('purchasing.receipts.paidBy', { bank: b.name }),
              })),
            ]}
          />
        </fieldset>
      </Panel>

      {/* The lines: set column widths, so typing moves nothing; every cell at the top, so a problem under one box
          leaves the others in line; each problem under its own box (W2-16 points 4-6). */}
      <Panel role="region" aria-labelledby={`${lineId}-lines`} className="px-1.5 pb-2.5">
        <h2 id={`${lineId}-lines`} className="m-0 px-2 pt-3.5 text-[15px] font-semibold">
          {t('purchasing.receipts.lines')}
        </h2>
        <Table aria-label={t('purchasing.receipts.lines')} className="min-w-[980px] table-fixed">
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-28" />
            <col className="w-[148px]" />
            <col className="w-[124px]" />
            <col className="w-28" />
            <col className="w-32" />
            <col className="w-12" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="text-end">
                <span aria-hidden="true">#</span>
                <span className="sr-only">{t('purchasing.line.number')}</span>
              </TableHead>
              <TableHead>{t('purchasing.line.item')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.qty')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.unitCost')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.discount')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.netCost')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.value')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('purchasing.line.remove')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell className="align-top text-end leading-9 text-muted-foreground tabular-nums">
                  {i + 1}
                </TableCell>
                <TableCell className="align-top">
                  <ItemPicker
                    api={api}
                    id={itemFieldId(i)}
                    label={t('purchasing.line.itemOf', { row: i + 1 })}
                    picked={l.item}
                    disabled={!can}
                    error={lineProblem(i, 'item')}
                    onLeave={problems.touch(`${i}:item`)}
                    onPick={(item) =>
                      put(i, {
                        item,
                        unitCost:
                          l.unitCost.trim() === '' && item.lastCost !== null
                            ? moneyText(item.lastCost, m.minorUnits)
                            : l.unitCost,
                      })
                    }
                  />
                </TableCell>
                <TableCell className="align-top">
                  <LineBox
                    label={t('purchasing.line.qtyOf', { row: i + 1 })}
                    disabled={!can}
                    value={l.qty}
                    error={lineProblem(i, 'qty')}
                    onBlur={problems.touch(`${i}:qty`)}
                    onChange={(e) => put(i, { qty: e.target.value })}
                  />
                </TableCell>
                <TableCell className="align-top">
                  <LineBox
                    label={t('purchasing.line.unitCostOf', { row: i + 1 })}
                    disabled={!can}
                    value={l.unitCost}
                    error={lineProblem(i, 'unitCost')}
                    notes={costNotes(i, l)}
                    onBlur={problems.touch(`${i}:unitCost`)}
                    onChange={(e) => put(i, { unitCost: e.target.value })}
                  />
                </TableCell>
                <TableCell className="align-top">
                  <LineBox
                    label={t('purchasing.line.discountOf', { row: i + 1 })}
                    disabled={!can}
                    value={l.lineDiscount}
                    error={lineProblem(i, 'discount')}
                    onBlur={problems.touch(`${i}:discount`)}
                    onChange={(e) => put(i, { lineDiscount: e.target.value })}
                    // Enter in the last box of the last line adds a line (W2-16).
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || i !== lines.length - 1) return;
                      e.preventDefault();
                      addLine(true);
                    }}
                  />
                </TableCell>
                <TableCell className="align-top text-end leading-9 tabular-nums">
                  {show(totals?.lines[rowOf(i)]?.netUnitCost ?? null)}
                </TableCell>
                <TableCell className="align-top text-end leading-9 tabular-nums">
                  {show(totals?.lines[rowOf(i)]?.value ?? null)}
                </TableCell>
                <TableCell className="align-top">
                  {can && lines.length > 1 && (
                    <IconButton
                      icon={Trash2}
                      tone="bad"
                      className="mt-0.5"
                      label={t('purchasing.line.removeOf', { row: i + 1 })}
                      onClick={() => setLines(lines.filter((_, k) => k !== i))}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {linesProblem && (
          <p role="alert" className="m-0 px-2 pt-2 text-xs font-medium text-bad">
            {linesProblem}
          </p>
        )}
        {can && (
          <div className="flex flex-wrap items-center gap-3 px-2 pt-2">
            <Button size="sm" variant="outline" icon={Plus} onClick={() => addLine(false)}>
              {t('purchasing.line.add')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('purchasing.line.enterHint')}</span>
          </div>
        )}
      </Panel>

      {/* The foot of the bill: its discount and its total as printed, beside the sums (W2-16). */}
      <Panel role="region" aria-labelledby={`${lineId}-foot`}>
        <h2 id={`${lineId}-foot`} className="m-0 px-3.5 pt-3.5 text-[15px] font-semibold">
          {t('purchasing.receipts.foot')}
        </h2>
        <div className="grid grid-cols-1 gap-6 p-3.5 md:grid-cols-2">
          <fieldset disabled={!can} className="m-0 grid grid-cols-1 gap-3.5 border-0 p-0 sm:grid-cols-2">
            <TextInput
              label={t('purchasing.fields.billDiscount')}
              inputMode="decimal"
              className="text-end tabular-nums"
              value={h.billDiscount}
              error={headProblem('billDiscount')}
              onBlur={problems.touch('billDiscount')}
              onChange={(e) => set('billDiscount', e.target.value)}
            />
            <TextInput
              label={t('purchasing.fields.billTotal')}
              hint={t('purchasing.fields.billTotalHint')}
              inputMode="decimal"
              className="text-end tabular-nums"
              value={h.billTotal}
              error={headProblem('billTotal')}
              onBlur={problems.touch('billTotal')}
              onChange={(e) => set('billTotal', e.target.value)}
            />
            <TextInput
              label={t('purchasing.fields.notes')}
              wrapperClassName="sm:col-span-2"
              value={h.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </fieldset>
          <dl
            className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 self-start rounded-lg bg-surface-2 px-3.5 py-3 text-sm"
            aria-label={t('purchasing.receipts.totals')}
          >
            <dt className="text-muted-foreground">{t('purchasing.totals.subtotal')}</dt>
            <dd className="m-0 text-end tabular-nums">{show(totals?.subtotal ?? null)}</dd>
            <dt className="text-muted-foreground">{t('purchasing.totals.lineDiscounts')}</dt>
            <dd className="m-0 text-end tabular-nums">{show(totals?.lineDiscountTotal ?? null)}</dd>
            <dt className="text-muted-foreground">{t('purchasing.totals.billDiscount')}</dt>
            <dd className="m-0 text-end tabular-nums">{show(totals?.billDiscount ?? null)}</dd>
            <dt className="border-t border-line pt-1.5 font-semibold">{t('purchasing.totals.total')}</dt>
            <dd className="m-0 border-t border-line pt-1.5 text-end font-semibold tabular-nums">
              {show(check.total)}
            </dd>
            <dt className="text-muted-foreground">{t('purchasing.totals.printed')}</dt>
            <dd className="m-0 text-end tabular-nums">
              {show(typeof billTotal === 'number' ? billTotal : null)}
            </dd>
            <dt className="text-muted-foreground">{t('purchasing.totals.difference')}</dt>
            <dd className={`m-0 text-end font-semibold tabular-nums ${differenceTone}`}>{difference}</dd>
          </dl>
        </div>
      </Panel>

      {/* Always in view at the bottom of the window while the lines are typed (W2-16). Delete sits apart from Post. */}
      {can && (
        <ActionBar label={t('purchasing.bar')}>
          {r && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="text-bad hover:bg-bad-soft hover:text-bad"
              disabled={act.busy !== null}
              onClick={() => setAsking(true)}
            >
              {t('purchasing.deleteDraft')}
            </Button>
          )}
          {/* What is left before posting: on a saved draft, quietly; in red once Post was pressed (W2-17). */}
          {(problems.all || r) && toFix > 0 && (
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-semibold ${problems.all ? 'text-bad' : 'text-muted-foreground'}`}
            >
              <CircleAlert aria-hidden="true" className="size-4" />
              {t('purchasing.toFix', { count: toFix })}
            </span>
          )}
          <div role="status" className="ms-auto flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              {t('purchasing.totals.total')}{' '}
              <strong className="ms-1 text-[15px] text-ink tabular-nums">{show(check.total)}</strong>
            </span>
            <span className="text-muted-foreground">
              {t('purchasing.totals.printed')}{' '}
              <strong className="ms-1 text-[15px] text-ink tabular-nums">
                {show(typeof billTotal === 'number' ? billTotal : null)}
              </strong>
            </span>
            <span className="text-muted-foreground">
              {t('purchasing.totals.difference')}{' '}
              <strong className={`ms-1 text-[15px] text-ink tabular-nums ${differenceTone}`}>
                {difference}
              </strong>
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => void act.run('save', saveDraft)()}
              variant="outline"
              icon={Save}
              busy={act.busy === 'save'}
              disabled={act.busy !== null}
            >
              {t('purchasing.saveDraft')}
            </Button>
            <Button
              onClick={() => (toFix > 0 ? problems.focusFirst() : void act.run('post', postIt)())}
              icon={Send}
              busy={act.busy === 'post'}
              disabled={act.busy !== null}
            >
              {t('purchasing.post')}
            </Button>
          </div>
        </ActionBar>
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={t('purchasing.deleteTitle')}
        actionLabel={t('purchasing.deleteDraft')}
        actionIcon={Trash2}
        cancelLabel={t('purchasing.cancel')}
        tone="danger"
        busy={act.busy === 'delete'}
        onConfirm={() => void act.run('delete', remove)()}
      >
        {t('purchasing.deleteText', { count: Math.max(used.length, 1) })}
      </ConfirmDialog>
    </div>
  );
}
