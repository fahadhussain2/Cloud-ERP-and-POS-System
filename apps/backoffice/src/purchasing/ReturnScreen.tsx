import type { DocumentRow, PurchasingLookups, ReceiptView, ReturnView } from '@erp/contracts';
import { checkReturn, money, mulQty, PURCHASE_RETURN_REASONS, qty as qtyOf } from '@erp/domain';
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
import { href, navigate } from '../router';
import { ItemPicker } from './ItemPicker';
import { PurchasingNotice } from './PurchasingNotice';
import { DocumentList } from './ReceiptScreen';
import { problemText, purchasingRefusal, today, usePurchasingLookups, type PickedItem } from './data';

// Purchase returns / debit notes (W1-16, PUR-03): goods back to the supplier, from a goods receipt where possible
// (its lines and net costs offered, no more than it still has), with a reason (owner answer 3). Posting takes the
// stock out and the supplier's balance down (posting rules §5.2).

export function ReturnsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [list, setList] = useState<DocumentRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/purchasing/returns').then(
      (r) => live && setList(r.status === 200 ? (r.body as { returns: DocumentRow[] }).returns : []),
    );
    return () => {
      live = false;
    };
  }, [api]);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader
        title={t('purchasing.returns.title')}
        help={t('purchasing.returns.help')}
        actions={
          lookups.can.receive && (
            <Button asChild size="lg">
              <a href={href.purchaseReturn('new')}>{t('purchasing.returns.add')}</a>
            </Button>
          )
        }
      />
      <PurchasingNotice lookups={lookups} />
      <DocumentList
        list={list}
        lookups={lookups}
        link={href.purchaseReturn}
        label={t('purchasing.returns.title')}
      />
    </>
  );
}

interface Line {
  item: PickedItem | { id: string | null; code: string | null; name: string | null; allowsFraction: boolean };
  receiptLineId: string | null;
  returnable: number | null;
  qty: string;
  unitCost: string;
}

/** `id` is a return's id, `new`, or `new-<receipt id>` for a return from that receipt. */
export function ReturnScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const fromReceipt = id.startsWith('new-') ? id.slice(4) : null;
  const isNew = id === 'new' || fromReceipt !== null;
  const [view, setView] = useState<ReturnView | null | undefined>(isNew ? null : undefined);
  const [receipt, setReceipt] = useState<ReceiptView | null | undefined>(fromReceipt ? undefined : null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    if (!isNew)
      void api('GET', `/api/purchasing/returns/${encodeURIComponent(id)}`).then(
        (r) => live && setView(r.status === 200 ? (r.body as ReturnView) : null),
      );
    if (fromReceipt)
      void api('GET', `/api/purchasing/receipts/${encodeURIComponent(fromReceipt)}`).then(
        (r) => live && setReceipt(r.status === 200 ? (r.body as ReceiptView) : null),
      );
    return () => {
      live = false;
    };
  }, [api, id, isNew, fromReceipt, version]);

  const back = (
    <a
      href={href.purchaseReturns}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('purchasing.returns.title')}
    </a>
  );
  if (lookups === null || view === undefined || receipt === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (view === null && !isNew) return <PageHeader eyebrow={back} title={t('purchasing.returns.notFound')} />;
  return (
    <ReturnForm
      key={view?.purchaseReturn.rowVersion ?? 'new'}
      api={api}
      lookups={lookups}
      view={view}
      receipt={receipt}
      back={back}
      onSaved={() => setVersion((v) => v + 1)}
    />
  );
}

function ReturnForm({
  api,
  lookups,
  view,
  receipt,
  back,
  onSaved,
}: {
  api: Api;
  lookups: PurchasingLookups;
  view: ReturnView | null;
  receipt: ReceiptView | null;
  back: ReactNode;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const m = lookups.money;
  const r = view?.purchaseReturn;
  const posted = r?.status === 'posted';
  const can = lookups.can.receive && !posted;
  const shop = lookups.locations.find((l) => l.code === 'SHOP')?.id ?? '';
  const [h, setH] = useState({
    supplierId: r?.supplierId ?? receipt?.receipt.supplierId ?? '',
    goodsReceiptId: r?.goodsReceiptId ?? receipt?.receipt.id ?? null,
    locationId: r?.locationId ?? receipt?.receipt.locationId ?? shop,
    returnedOn: r?.returnedOn ?? today(),
    reason: r?.reason ?? '',
    note: r?.note ?? '',
  });
  const [lines, setLines] = useState<Line[]>(
    view
      ? view.lines.map((l) => ({
          item: { id: l.itemId, code: l.code, name: l.name, allowsFraction: l.allowsFraction },
          receiptLineId: l.receiptLineId,
          returnable: l.returnable,
          qty: qtyText(l.qty),
          unitCost: moneyText(l.unitCost, m.minorUnits),
        }))
      : receipt
        ? receipt.lines.map((l) => ({
            item: { id: l.itemId, code: l.code, name: l.name, allowsFraction: l.allowsFraction },
            receiptLineId: l.id,
            returnable: null,
            qty: '',
            unitCost: moneyText(l.netUnitCost, m.minorUnits),
          }))
        : [
            {
              item: { id: null, code: null, name: null, allowsFraction: false },
              receiptLineId: null,
              returnable: null,
              qty: '',
              unitCost: '',
            },
          ],
  );
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const set = (k: keyof typeof h, v: string) => setH((x) => ({ ...x, [k]: v }));
  const put = (n: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const ids = { supplier: useId(), location: useId(), reason: useId() };
  const exists = (k: string) => t(k) !== k;
  const nan = (v: number | null | undefined) => (v === undefined ? Number.NaN : (v ?? 0));
  // Lines from a receipt with no quantity typed are not being returned.
  const used = lines.filter((l) => l.qty.trim() !== '' || l.receiptLineId === null);
  const check = checkReturn({
    supplierId: h.supplierId || null,
    locationId: h.locationId || null,
    reason: h.reason || null,
    note: h.note,
    lines: used.map((l) => ({
      itemId: l.item.id,
      qty: nan(qtyValue(l.qty)),
      unitCost: nan(moneyValue(l.unitCost, m.minorUnits)),
      allowsFraction: l.item.allowsFraction,
      returnable: l.returnable,
    })),
  });

  const body = () => ({
    supplierId: h.supplierId || null,
    goodsReceiptId: h.goodsReceiptId,
    locationId: h.locationId,
    returnedOn: h.returnedOn,
    reason: h.reason || null,
    note: h.note,
    lines: used.map((l) => ({
      itemId: l.item.id,
      receiptLineId: l.receiptLineId,
      qty: qtyValue(l.qty) ?? 0,
      unitCost: moneyValue(l.unitCost, m.minorUnits) ?? 0,
    })),
  });
  const save = async (): Promise<{ id: string; rowVersion: string } | null> => {
    const res = r
      ? await api('PUT', `/api/purchasing/returns/${encodeURIComponent(r.id)}`, {
          ...body(),
          rowVersion: r.rowVersion,
        })
      : await api('POST', '/api/purchasing/returns', body());
    if (res.status === 200) return { id: r!.id, rowVersion: (res.body as { rowVersion: string }).rowVersion };
    if (res.status === 201) return res.body as { id: string; rowVersion: string };
    setMessage({ text: purchasingRefusal(t, exists, res.body), error: true });
    return null;
  };
  const after = (id: string) => {
    if (!r) navigate(href.purchaseReturn(id));
    else onSaved();
  };
  const postIt = async () => {
    const s = await save();
    if (!s) return;
    const res = await api('POST', `/api/purchasing/returns/${encodeURIComponent(s.id)}/post`, {
      rowVersion: s.rowVersion,
    });
    if (res.status !== 200) setMessage({ text: purchasingRefusal(t, exists, res.body), error: true });
    after(s.id);
  };

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={r?.number ?? t('purchasing.returns.new')}
        help={
          <span className="flex flex-wrap items-center gap-2">
            {posted && <StatusChip tone="ok">{t('purchasing.posted')}</StatusChip>}
            {(r?.goodsReceiptNumber ?? receipt?.receipt.number) &&
              t('purchasing.returns.of', { number: r?.goodsReceiptNumber ?? receipt?.receipt.number })}
          </span>
        }
      />
      <PurchasingNotice lookups={lookups} />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <Panel>
        <fieldset disabled={!can} className="m-0 grid gap-3.5 border-0 p-3.5 md:grid-cols-4">
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <label htmlFor={ids.supplier} className={LABEL_CLASS}>
              {t('purchasing.fields.supplier')}
            </label>
            <select
              id={ids.supplier}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.supplierId}
              disabled={h.goodsReceiptId !== null}
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
              {lookups.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('purchasing.fields.returnedOn')}
            type="date"
            value={h.returnedOn}
            onChange={(e) => set('returnedOn', e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.reason} className={LABEL_CLASS}>
              {t('purchasing.fields.reason')}
            </label>
            <select
              id={ids.reason}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.reason}
              onChange={(e) => set('reason', e.target.value)}
            >
              <option value="">—</option>
              {PURCHASE_RETURN_REASONS.map((x) => (
                <option key={x} value={x}>
                  {t(`purchasing.reasons.${x}`)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('purchasing.fields.note')}
            value={h.note}
            onChange={(e) => set('note', e.target.value)}
            wrapperClassName="md:col-span-3"
          />
        </fieldset>
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('purchasing.returns.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40%]">{t('purchasing.line.item')}</TableHead>
              <TableHead>{t('purchasing.line.qty')}</TableHead>
              <TableHead>{t('purchasing.line.returnCost')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.value')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const q = qtyValue(l.qty);
              const c = moneyValue(l.unitCost, m.minorUnits);
              const value =
                typeof q === 'number' && typeof c === 'number' ? mulQty(qtyOf(q), money(c)) : null;
              const row = used.indexOf(l);
              return (
                <TableRow key={i}>
                  <TableCell>
                    {l.receiptLineId ? (
                      <span>
                        <span className="font-mono font-semibold">{l.item.code}</span> {l.item.name}
                      </span>
                    ) : (
                      <ItemPicker
                        api={api}
                        label={t('purchasing.line.itemOf', { row: i + 1 })}
                        picked={l.item}
                        disabled={!can}
                        onPick={(item) => put(i, { item })}
                      />
                    )}
                    {row >= 0 &&
                      check.problems
                        .filter((p) => p.row === row)
                        .map((p, k) => (
                          <p key={k} className="m-0 mt-1 text-xs text-destructive">
                            {problemText(t, exists, p.problem, null)}
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
                  <TableCell className="text-end tabular-nums">
                    {value === null ? '—' : formatMoney(value, m)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {can && h.goodsReceiptId === null && (
          <div className="px-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setLines([
                  ...lines,
                  {
                    item: { id: null, code: null, name: null, allowsFraction: false },
                    receiptLineId: null,
                    returnable: null,
                    qty: '',
                    unitCost: '',
                  },
                ])
              }
            >
              {t('purchasing.line.add')}
            </Button>
          </div>
        )}
        <p className="m-0 px-2 pt-2 text-end font-semibold" role="status">
          {t('purchasing.returns.total', {
            amount: check.total === null ? '—' : formatMoney(check.total, m),
          })}
        </p>
      </Panel>
      {check.problems.some((p) => p.row === null) && !posted && (
        <p className="m-0 text-sm text-muted-foreground">
          {check.problems
            .filter((p) => p.row === null)
            .map((p) => problemText(t, exists, p.problem, null))
            .join(' ')}
        </p>
      )}
      {can && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void save().then((s) => {
                if (s) {
                  setMessage({ text: t('purchasing.returns.saved'), error: false });
                  after(s.id);
                }
              })
            }
          >
            {t('purchasing.saveDraft')}
          </Button>
          <Button onClick={() => void postIt()} disabled={check.problems.length > 0}>
            {t('purchasing.post')}
          </Button>
        </div>
      )}
    </>
  );
}
