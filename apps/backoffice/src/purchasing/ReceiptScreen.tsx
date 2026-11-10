import type { DocumentRow, PurchasingLookups, ReceiptView } from '@erp/contracts';
import { checkReceipt, isDateLocked, receiptTotals } from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Button,
  formatMoney,
  Input,
  LABEL_CLASS,
  PageHeader,
  Panel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextField,
} from '@erp/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyText, moneyValue, qtyText, qtyValue } from '../catalog/data';
import { carry, href, navigate, takeCarried } from '../router';
import { ItemPicker } from './ItemPicker';
import { PurchasingNotice } from './PurchasingNotice';
import { problemText, purchasingRefusal, today, usePurchasingLookups, type PickedItem } from './data';

// Goods receipts (W1-16, PUR-02): the list, and one receipt typed from the supplier's bill. As you type, the screen
// checks it with the same rules as the server: the difference from the bill total as printed (posting waits until
// it is 0), the line problems, and the warnings (a cost more than 10 % off the last one, Retail at or below the new
// cost). Save keeps a draft; Post makes it final (rule 3). Paid in cash: the cashier pays it at the desk afterwards
// (owner answer 1).

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
            <Button asChild size="lg">
              <a href={href.receipt('new')}>{t('purchasing.receipts.add')}</a>
            </Button>
          )
        }
      />
      <PurchasingNotice lookups={lookups} />
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
    <Panel className="px-1.5 pb-2.5">
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
  const r = view?.receipt;
  const posted = r?.status === 'posted';
  const can = lookups.can.receive && !posted;
  const shop = lookups.locations.find((l) => l.code === 'SHOP')?.id ?? lookups.locations[0]?.id ?? '';
  const [h, setH] = useState({
    supplierId: r?.supplierId ?? '',
    billNo: r?.billNo ?? '',
    billDate: r?.billDate ?? today(),
    receivedOn: r?.receivedOn ?? today(),
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
  // A refusal from just before this form opened (a new draft at its own address, or a reload): see `carry`.
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(() => {
    const text = takeCarried(href.receipt(r?.id ?? 'new'));
    return text === null ? null : { text, error: true };
  });
  const set = (k: keyof typeof h, v: string) => setH((x) => ({ ...x, [k]: v }));
  const put = (n: number, patch: Partial<LineForm>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const ids = { supplier: useId(), location: useId(), paid: useId() };

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
      lineDiscount: n(moneyValue(l.lineDiscount, m.minorUnits) ?? 0),
      allowsFraction: l.item.allowsFraction,
      lastCost: posted ? null : l.item.lastCost,
      retail: l.item.retail,
    }));
  const billTotal = moneyValue(h.billTotal, m.minorUnits);
  // A date on or before the lock date can't post (D-108): Post waits, and the date says why. Save draft still works.
  const locked = isDateLocked(h.receivedOn, lookups.lockDate)
    ? t('purchasing.errors.date_locked', { date: lookups.lockDate })
    : null;
  const check = checkReceipt({
    supplierId: h.supplierId || null,
    billNo: h.billNo,
    billDate: h.billDate || null,
    locationId: h.locationId || null,
    billDiscount: n(moneyValue(h.billDiscount, m.minorUnits) ?? 0),
    billTotal: billTotal === undefined ? null : billTotal,
    lines: parsed.map((p) => ({ ...p, qty: p.qty ?? 0, unitCost: p.unitCost ?? 0 })),
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
          billDiscount: n(moneyValue(h.billDiscount, m.minorUnits) ?? 0),
        });
  const show = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, m));
  const exists = (k: string) => t(k) !== k;

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
    const res = r
      ? await api('PUT', `/api/purchasing/receipts/${encodeURIComponent(r.id)}`, {
          ...body(),
          rowVersion: r.rowVersion,
        })
      : await api('POST', '/api/purchasing/receipts', body());
    if (res.status === 200) return { id: r!.id, rowVersion: (res.body as { rowVersion: string }).rowVersion };
    if (res.status === 201) return res.body as { id: string; rowVersion: string };
    setMessage({ text: purchasingRefusal(t, exists, res.body), error: true });
    return null;
  };
  const saveDraft = async () => {
    const s = await save();
    if (!s) return;
    if (!r) navigate(href.receipt(s.id));
    else {
      setMessage({ text: t('purchasing.receipts.saved'), error: false });
      await onSaved();
    }
  };
  const postIt = async () => {
    const s = await save();
    if (!s) return;
    const res = await api('POST', `/api/purchasing/receipts/${encodeURIComponent(s.id)}/post`, {
      rowVersion: s.rowVersion,
    });
    if (res.status === 200) {
      if (!r) navigate(href.receipt(s.id));
      else await onSaved();
      return;
    }
    // The draft was saved before Post was refused: open it again, as saved, with the refusal.
    const text = purchasingRefusal(t, exists, res.body);
    if (!r) return navigate(href.receipt(s.id), text);
    setMessage({ text, error: true });
    carry(href.receipt(s.id), text);
    await onSaved();
  };
  const remove = async () => {
    if (!r) return;
    const res = await api('DELETE', `/api/purchasing/receipts/${encodeURIComponent(r.id)}`);
    if (res.status === 200) navigate(href.receipts);
    else setMessage({ text: purchasingRefusal(t, exists, res.body), error: true });
  };

  const header = check.problems.filter(
    (p) => p.row === null && p.problem !== 'total_mismatch' && p.problem !== 'total_required',
  );
  const warningsOf = (i: number) => check.warnings.filter((w) => rowOf(i) >= 0 && w.row === rowOf(i));
  const problemsOf = (i: number) => check.problems.filter((p) => rowOf(i) >= 0 && p.row === rowOf(i));

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={r?.number ?? t('purchasing.receipts.new')}
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
              {/* W1-17: the received pieces' labels (CAT-08). */}
              <Button asChild variant="outline">
                <a href={href.receiptLabels(r.id)}>{t('labels.makeLabels')}</a>
              </Button>
              <Button asChild variant="outline">
                <a href={href.purchaseReturn(`new-${r.id}`)}>{t('purchasing.returns.fromReceipt')}</a>
              </Button>
            </span>
          )
        }
      />
      <PurchasingNotice lookups={lookups} />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <Panel role="region" aria-label={t('purchasing.receipts.bill')}>
        <fieldset disabled={!can} className="m-0 grid gap-3.5 border-0 p-3.5 md:grid-cols-4">
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <label htmlFor={ids.supplier} className={LABEL_CLASS}>
              {t('purchasing.fields.supplier')}
            </label>
            <select
              id={ids.supplier}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.supplierId}
              onChange={(e) => set('supplierId', e.target.value)}
            >
              <option value="">—</option>
              {lookups.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('purchasing.fields.billNo')}
            value={h.billNo}
            onChange={(e) => set('billNo', e.target.value)}
          />
          <TextField
            label={t('purchasing.fields.billDate')}
            type="date"
            value={h.billDate}
            onChange={(e) => set('billDate', e.target.value)}
          />
          <TextField
            label={t('purchasing.fields.receivedOn')}
            type="date"
            error={locked}
            value={h.receivedOn}
            onChange={(e) => set('receivedOn', e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.location} className={LABEL_CLASS}>
              {t('purchasing.fields.location')}
            </label>
            <select
              id={ids.location}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.locationId}
              onChange={(e) => set('locationId', e.target.value)}
            >
              {lookups.locations
                .filter((l) => l.code !== 'DAMAGED')
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.paid} className={LABEL_CLASS}>
              {t('purchasing.fields.paid')}
            </label>
            <select
              id={ids.paid}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.paidFrom}
              onChange={(e) => set('paidFrom', e.target.value)}
            >
              <option value="">{t('purchasing.receipts.onAccount')}</option>
              {lookups.bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>
                  {t('purchasing.receipts.paidBy', { bank: b.name })}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('purchasing.fields.billTotal')}
            hint={t('purchasing.fields.billTotalHint')}
            inputMode="decimal"
            value={h.billTotal}
            onChange={(e) => set('billTotal', e.target.value)}
          />
        </fieldset>
        {!h.paidFrom && !posted && (
          <p className="m-0 px-3.5 pb-3 text-sm text-muted-foreground">{t('purchasing.receipts.cashHint')}</p>
        )}
      </Panel>

      <Panel role="region" aria-label={t('purchasing.receipts.lines')} className="px-1.5 pb-2.5">
        <Table aria-label={t('purchasing.receipts.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[34%]">{t('purchasing.line.item')}</TableHead>
              <TableHead>{t('purchasing.line.qty')}</TableHead>
              <TableHead>{t('purchasing.line.unitCost')}</TableHead>
              <TableHead>{t('purchasing.line.discount')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.netCost')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.value')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('purchasing.line.remove')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => (
              // Every cell at the top, so a line's messages under its item don't push its fields down.
              <TableRow key={i} className="align-top">
                <TableCell>
                  <ItemPicker
                    api={api}
                    label={t('purchasing.line.itemOf', { row: i + 1 })}
                    picked={l.item}
                    disabled={!can}
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
                  {[
                    ...problemsOf(i).map((p) => ({
                      text: problemText(t, exists, p.problem, null),
                      bad: true,
                    })),
                    ...warningsOf(i).map((w) => ({
                      text: t(`purchasing.warnings.${w.warning}`),
                      bad: false,
                    })),
                  ].map((x, k) => (
                    <p key={k} className={`m-0 mt-1 text-xs ${x.bad ? 'text-destructive' : 'text-warn'}`}>
                      {x.text}
                    </p>
                  ))}
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={t('purchasing.line.qtyOf', { row: i + 1 })}
                    className="h-9 w-24"
                    inputMode="decimal"
                    disabled={!can}
                    value={l.qty}
                    onChange={(e) => put(i, { qty: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={t('purchasing.line.unitCostOf', { row: i + 1 })}
                    className="h-9 w-28"
                    inputMode="decimal"
                    disabled={!can}
                    value={l.unitCost}
                    onChange={(e) => put(i, { unitCost: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    aria-label={t('purchasing.line.discountOf', { row: i + 1 })}
                    className="h-9 w-24"
                    inputMode="decimal"
                    disabled={!can}
                    value={l.lineDiscount}
                    onChange={(e) => put(i, { lineDiscount: e.target.value })}
                  />
                </TableCell>
                <TableCell className="text-end leading-9 tabular-nums">
                  {show(totals?.lines[rowOf(i)]?.netUnitCost ?? null)}
                </TableCell>
                <TableCell className="text-end leading-9 tabular-nums">
                  {show(totals?.lines[rowOf(i)]?.value ?? null)}
                </TableCell>
                <TableCell>
                  {can && lines.length > 1 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setLines(lines.filter((_, k) => k !== i))}
                    >
                      {t('purchasing.line.remove')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {can && (
          <div className="px-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => setLines([...lines, blankLine()])}>
              {t('purchasing.line.add')}
            </Button>
          </div>
        )}
      </Panel>

      <Panel className="grid gap-3.5 p-3.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <fieldset disabled={!can} className="m-0 grid gap-3.5 border-0 p-0">
          <TextField
            label={t('purchasing.fields.billDiscount')}
            inputMode="decimal"
            value={h.billDiscount}
            onChange={(e) => set('billDiscount', e.target.value)}
          />
          <TextField
            label={t('purchasing.fields.notes')}
            value={h.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </fieldset>
        <dl
          className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 self-start text-sm"
          aria-label={t('purchasing.receipts.totals')}
        >
          <dt>{t('purchasing.totals.subtotal')}</dt>
          <dd className="m-0 text-end tabular-nums">{show(totals?.subtotal ?? null)}</dd>
          <dt>{t('purchasing.totals.lineDiscounts')}</dt>
          <dd className="m-0 text-end tabular-nums">{show(totals?.lineDiscountTotal ?? null)}</dd>
          <dt>{t('purchasing.totals.billDiscount')}</dt>
          <dd className="m-0 text-end tabular-nums">{show(totals?.billDiscount ?? null)}</dd>
          <dt className="font-semibold">{t('purchasing.totals.total')}</dt>
          <dd className="m-0 text-end font-semibold tabular-nums">{show(check.total)}</dd>
          <dt>{t('purchasing.totals.printed')}</dt>
          <dd className="m-0 text-end tabular-nums">
            {show(typeof billTotal === 'number' ? billTotal : null)}
          </dd>
          <dt>{t('purchasing.totals.difference')}</dt>
          <dd
            role="status"
            className={`m-0 text-end font-semibold tabular-nums ${check.difference === 0 ? 'text-ok' : 'text-destructive'}`}
          >
            {check.difference === null
              ? '—'
              : check.difference === 0
                ? t('purchasing.totals.matches')
                : formatMoney(check.difference, m)}
          </dd>
        </dl>
      </Panel>

      {header.length > 0 && !posted && (
        <p className="m-0 text-sm text-muted-foreground">
          {header.map((p) => problemText(t, exists, p.problem, null)).join(' ')}
        </p>
      )}
      {can && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void saveDraft()} variant="outline">
            {t('purchasing.saveDraft')}
          </Button>
          <Button onClick={() => void postIt()} disabled={check.problems.length > 0 || locked !== null}>
            {t('purchasing.post')}
          </Button>
          {r && (
            <Button variant="ghost" onClick={() => void remove()}>
              {t('purchasing.deleteDraft')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
