import type { DocumentRow, PurchasingLookups, ReceiptView, ReturnView } from '@erp/contracts';
import {
  amountLimit,
  checkReturn,
  isEmptyDraft,
  money,
  mulQty,
  PURCHASE_RETURN_REASONS,
  qty as qtyOf,
} from '@erp/domain';
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
import { CircleAlert, Plus, Save, Send, Trash2 } from 'lucide-react';
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
  ListPicker,
  notify,
  Select,
  TextInput,
  useOneAtATime,
} from '../ui';
import { ItemPicker } from './ItemPicker';
import { DocumentList } from './ReceiptScreen';
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
} from './lineFields';

// Purchase returns / debit notes (W1-16, PUR-03): goods back to the supplier, from a goods receipt where possible
// (its lines and net costs offered, no more than it still has), with a reason (owner answer 3). Posting takes the
// stock out and the supplier's balance down (posting rules §5.2). W2-14 (D-127): the back office's own controls; the
// supplier is searched (owner answer 3), and results and refusals are toasts (owner answer 6). W2-16 (owner's review,
// 2026-11-28): the goods receipt's layout: a # column, each problem under its own field, how many can still go back
// under each quantity, the total with Save, Post and Delete draft in a bar kept at the bottom of the window. W2-17
// (owner's staging test): no amount over Rs 1 crore; a box that can't be read can't be saved; Save draft marks nothing
// red but says what is left; one save at a time; short words under a line's boxes.

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
            <a href={href.purchaseReturn('new')} className={buttonClass()}>
              <Plus aria-hidden="true" className="size-4" />
              {t('purchasing.returns.add')}
            </a>
          )
        }
      />
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
  // No amount over Rs 1 crore, in the shop's money (W2-17, owner answer 1).
  const limit = amountLimit(m.minorUnits);
  const limitText = formatMoney(limit, m);
  const r = view?.purchaseReturn;
  const posted = r?.status === 'posted';
  const can = lookups.can.receive && !posted;
  const shop = lookups.locations.find((l) => l.code === 'SHOP')?.id ?? '';
  const [h, setH] = useState({
    supplierId: r?.supplierId ?? receipt?.receipt.supplierId ?? '',
    goodsReceiptId: r?.goodsReceiptId ?? receipt?.receipt.id ?? null,
    locationId: r?.locationId ?? receipt?.receipt.locationId ?? shop,
    returnedOn: r?.returnedOn ?? lookups.today,
    reason: r?.reason ?? '',
    note: r?.note ?? '',
  });
  const [lines, setLines] = useState<Line[]>(
    view
      ? view.lines.map((l) => ({
          item: {
            id: l.itemId,
            code: l.code,
            name: l.name,
            allowsFraction: l.allowsFraction,
          },
          receiptLineId: l.receiptLineId,
          returnable: l.returnable,
          qty: qtyText(l.qty),
          unitCost: moneyText(l.unitCost, m.minorUnits),
        }))
      : receipt
        ? receipt.lines.map((l) => ({
            item: {
              id: l.itemId,
              code: l.code,
              name: l.name,
              allowsFraction: l.allowsFraction,
            },
            receiptLineId: l.id,
            // What the receipt still has, known before the first save (W2-16): "Up to 6", checked as typed.
            returnable: l.returnable,
            qty: '',
            unitCost: moneyText(l.netUnitCost, m.minorUnits),
          }))
        : [freeLine()],
  );
  // A refusal from just before this form opened (a new draft at its own address): see `carry`. A toast, as any
  // refusal (owner answer 6).
  const [carried] = useState(() => takeCarried(href.purchaseReturn(r?.id ?? 'new')));
  useEffect(() => {
    if (carried !== null) notify.problem(carried);
  }, [carried]);
  const set = (k: keyof typeof h, v: string) => setH((x) => ({ ...x, [k]: v }));
  const put = (n: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const exists = (k: string) => t(k) !== k;
  const nan = (v: number | null | undefined) => (v === undefined ? Number.NaN : (v ?? 0));
  const form = useRef<HTMLDivElement>(null);
  const problems = useShownProblems(form);
  // A line added with Enter gets the cursor in its item (W2-16).
  const formId = useId();
  const itemFieldId = (i: number) => `${formId}-item-${i}`;
  const focusLater = useFocusNewLine(lines.length, itemFieldId);
  const addLine = (focus: boolean) => {
    setLines((ls) => [...ls, freeLine()]);
    if (focus) focusLater(lines.length);
  };
  // Lines from a receipt with no quantity typed are not being returned; a free line not filled in yet is just a line
  // to come (owner review, 2026-11-07).
  const used = lines.filter((l) =>
    l.receiptLineId !== null
      ? l.qty.trim() !== ''
      : l.item.id !== null || l.qty.trim() !== '' || l.unitCost.trim() !== '',
  );
  // A date on or before the lock date can't post (D-108): the date says why, and Post marks it. Save draft still
  // works.
  const locked = dateProblem(t, h.returnedOn, lookups);
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
    maxAmount: limit,
  });
  const toFix = check.problems.length + (locked === null ? 0 : 1);
  const headProblem = (field: string) => {
    if (!problems.shown(field)) return undefined;
    const p = check.problems.filter((x) => x.row === null && HEAD_FIELD[x.problem] === field);
    return p.length === 0
      ? undefined
      : p.map((x) => problemText(t, exists, x.problem, null, limitText)).join(' ');
  };
  // A box whose text isn't a number (W2-17): its problem says so, and Save draft can't keep it.
  const unreadable = (l: Line, field: LineField) =>
    field === 'qty'
      ? l.qty.trim() !== '' && qtyValue(l.qty) === undefined
      : field === 'unitCost' &&
        l.unitCost.trim() !== '' &&
        moneyValue(l.unitCost, m.minorUnits) === undefined;
  // Under a line's box, the short words (W2-17).
  const lineProblem = (l: Line, i: number, field: LineField) => {
    const row = used.indexOf(l);
    if (row < 0 || !problems.shown(`${i}:${field}`)) return undefined;
    if (unreadable(l, field)) return t(`purchasing.short.${field === 'qty' ? 'not_number' : 'not_amount'}`);
    const p = check.problems.filter((x) => x.row === row && lineFieldOf(x.problem) === field);
    return p.length === 0
      ? undefined
      : p.map((x) => shortProblemText(t, exists, x.problem, limitText)).join(' ');
  };
  /** The boxes Save draft can't keep (W2-17): text that isn't a number, and any amount over the limit. */
  const unsaveable = () => {
    const keys: string[] = [];
    lines.forEach((l, i) => {
      if (!used.includes(l)) return;
      for (const f of ['qty', 'unitCost'] as const) if (unreadable(l, f)) keys.push(`${i}:${f}`);
    });
    for (const x of check.problems)
      if (x.problem.endsWith('_too_large'))
        keys.push(x.row === null ? 'billTotal' : `${lines.indexOf(used[x.row]!)}:${lineFieldOf(x.problem)}`);
    return keys;
  };
  const linesProblem = [headProblem('lines'), headProblem('billTotal')].filter(Boolean).join(' ');

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
      ? await api('PUT', `/api/purchasing/returns/${encodeURIComponent(r.id)}`, {
          ...body(),
          rowVersion: r.rowVersion,
        })
      : await api('POST', '/api/purchasing/returns', body());
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
  // A draft can be deleted, after asking (W2-16 point 7); the API refuses a posted one.
  const [asking, setAsking] = useState(false);
  const remove = async () => {
    if (!r) return false;
    const res = await api('DELETE', `/api/purchasing/returns/${encodeURIComponent(r.id)}`);
    if (res.status === 200) {
      notify.done(t('purchasing.deleted'));
      navigate(href.purchaseReturns);
      return true;
    }
    notify.problem(purchasingRefusal(t, exists, res.body, m));
    return false;
  };
  const after = (id: string) => {
    if (!r) navigate(href.purchaseReturn(id));
    else onSaved();
  };
  // A draft may be incomplete: Save draft keeps it, marks nothing, and says what is left before posting (W2-17, owner
  // answer 2).
  const saveDraft = async () => {
    const s = await save();
    if (!s) return false;
    notify.done(toFix > 0 ? t('purchasing.savedToFix', { count: toFix }) : t('purchasing.returns.saved'));
    after(s.id);
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
    const res = await api('POST', `/api/purchasing/returns/${encodeURIComponent(s.id)}/post`, {
      rowVersion: s.rowVersion,
    });
    // The draft was saved before Post was refused: it opens again, as saved, and the refusal is a toast, which
    // outlives the reload or the move to the new draft's own address.
    if (res.status !== 200) notify.problem(purchasingRefusal(t, exists, res.body, m));
    after(s.id);
    return true;
  };
  const free = h.goodsReceiptId === null;

  return (
    <div ref={form} className="contents">
      <PageHeader
        eyebrow={back}
        title={
          r?.number ?? (
            <>
              {t('purchasing.returns.new')}
              {r && (
                <span className="ms-2.5 inline-block align-middle text-base">
                  <StatusChip tone="warn">{t('purchasing.draft')}</StatusChip>
                </span>
              )}
            </>
          )
        }
        help={
          <span className="flex flex-wrap items-center gap-2">
            {posted && <StatusChip tone="ok">{t('purchasing.posted')}</StatusChip>}
            {(r?.goodsReceiptNumber ?? receipt?.receipt.number) &&
              t('purchasing.returns.of', {
                number: r?.goodsReceiptNumber ?? receipt?.receipt.number,
              })}
          </span>
        }
      />
      <Panel>
        <fieldset disabled={!can} className="m-0 grid grid-cols-1 gap-3.5 border-0 p-3.5 md:grid-cols-4">
          <div className="md:col-span-2" onBlur={problems.touch('supplier')}>
            <ListPicker
              label={t('purchasing.fields.supplier')}
              options={lookups.suppliers}
              value={h.supplierId}
              disabled={!free}
              error={headProblem('supplier')}
              onChange={(v) => set('supplierId', v)}
            />
          </div>
          <Select
            label={t('purchasing.fields.location')}
            disabled={!can}
            value={h.locationId}
            error={headProblem('location')}
            onValueChange={(v) => set('locationId', v)}
            options={lookups.locations.map((l) => ({
              value: l.id,
              label: l.name,
            }))}
          />
          <TextInput
            label={t('purchasing.fields.returnedOn')}
            type="date"
            error={locked}
            max={lookups.today}
            value={h.returnedOn}
            onChange={(e) => set('returnedOn', e.target.value)}
          />
          <Select
            label={t('purchasing.fields.reason')}
            disabled={!can}
            placeholder="—"
            value={h.reason}
            error={headProblem('reason')}
            onValueChange={(v) => {
              set('reason', v);
              problems.touch('reason')();
            }}
            options={PURCHASE_RETURN_REASONS.map((x) => ({
              value: x,
              label: t(`purchasing.reasons.${x}`),
            }))}
          />
          <TextInput
            label={t('purchasing.fields.note')}
            value={h.note}
            error={headProblem('note')}
            onBlur={problems.touch('note')}
            onChange={(e) => set('note', e.target.value)}
            wrapperClassName="md:col-span-3"
          />
        </fieldset>
      </Panel>
      {/* The same lines table as a goods receipt's (W2-16): set widths, every cell at the top, each problem under its
          own box, how many can go back under the quantity. */}
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('purchasing.returns.lines')} className="min-w-[760px] table-fixed">
          <colgroup>
            <col className="w-10" />
            <col />
            <col className="w-[124px]" />
            <col className="w-[148px]" />
            <col className="w-36" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="text-end">
                <span aria-hidden="true">#</span>
                <span className="sr-only">{t('purchasing.line.number')}</span>
              </TableHead>
              <TableHead>{t('purchasing.line.item')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.qty')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.returnCost')}</TableHead>
              <TableHead className="text-end">{t('purchasing.line.value')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const q = qtyValue(l.qty);
              const c = moneyValue(l.unitCost, m.minorUnits);
              // Only a line within the limit has a value to show: a bigger one can't be worked out (W2-17).
              const value =
                typeof q === 'number' &&
                typeof c === 'number' &&
                c >= 0 &&
                (BigInt(q) * BigInt(c)) / 1000n <= BigInt(limit)
                  ? mulQty(qtyOf(q), money(c))
                  : null;
              const itemProblem = lineProblem(l, i, 'item');
              return (
                <TableRow key={i}>
                  <TableCell className="align-top text-end leading-9 text-muted-foreground tabular-nums">
                    {i + 1}
                  </TableCell>
                  <TableCell className="align-top">
                    {l.receiptLineId ? (
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="truncate leading-9">
                          <span className="font-mono font-semibold">{l.item.code}</span>{' '}
                          <span className="text-muted-foreground">{l.item.name}</span>
                        </span>
                        {itemProblem && (
                          <p
                            role="alert"
                            className="m-0 text-xs font-medium [overflow-wrap:anywhere] whitespace-normal text-bad"
                          >
                            {itemProblem}
                          </p>
                        )}
                      </div>
                    ) : (
                      <ItemPicker
                        api={api}
                        id={itemFieldId(i)}
                        label={t('purchasing.line.itemOf', { row: i + 1 })}
                        picked={l.item}
                        disabled={!can}
                        error={itemProblem}
                        onLeave={problems.touch(`${i}:item`)}
                        onPick={(item) => put(i, { item })}
                      />
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <LineBox
                      label={t('purchasing.line.qtyOf', { row: i + 1 })}
                      disabled={!can}
                      value={l.qty}
                      error={lineProblem(l, i, 'qty')}
                      notes={
                        l.returnable === null || posted
                          ? []
                          : [
                              {
                                text: t('purchasing.returns.upTo', {
                                  qty: qtyText(l.returnable),
                                }),
                              },
                            ]
                      }
                      onBlur={problems.touch(`${i}:qty`)}
                      onChange={(e) => put(i, { qty: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <LineBox
                      label={t('purchasing.line.unitCostOf', { row: i + 1 })}
                      disabled={!can}
                      value={l.unitCost}
                      error={lineProblem(l, i, 'unitCost')}
                      onBlur={problems.touch(`${i}:unitCost`)}
                      onChange={(e) => put(i, { unitCost: e.target.value })}
                      // Enter in the last box of the last line adds one, on a return not from a receipt (W2-16).
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || !free || i !== lines.length - 1) return;
                        e.preventDefault();
                        addLine(true);
                      }}
                    />
                  </TableCell>
                  <TableCell className="align-top text-end leading-9 tabular-nums">
                    {value === null ? '—' : formatMoney(value, m)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {linesProblem && (
          <p role="alert" className="m-0 px-2 pt-2 text-xs font-medium text-bad">
            {linesProblem}
          </p>
        )}
        {can && free && (
          <div className="flex flex-wrap items-center gap-3 px-2 pt-2">
            <Button size="sm" variant="outline" icon={Plus} onClick={() => addLine(false)}>
              {t('purchasing.line.add')}
            </Button>
            <span className="text-xs text-muted-foreground">{t('purchasing.line.enterHint')}</span>
          </div>
        )}
        {!can && (
          <p className="m-0 px-2 pt-2 text-end font-semibold">
            {t('purchasing.returns.total', {
              amount: check.total === null ? '—' : formatMoney(check.total, m),
            })}
          </p>
        )}
      </Panel>
      {/* Always in view at the bottom of the window (W2-16). Delete sits apart from Post. */}
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
          <p role="status" className="m-0 ms-auto text-[15px] font-semibold tabular-nums">
            {t('purchasing.returns.total', {
              amount: check.total === null ? '—' : formatMoney(check.total, m),
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              icon={Save}
              busy={act.busy === 'save'}
              disabled={act.busy !== null}
              onClick={() => void act.run('save', saveDraft)()}
            >
              {t('purchasing.saveDraft')}
            </Button>
            <Button
              icon={Send}
              busy={act.busy === 'post'}
              disabled={act.busy !== null}
              onClick={() => (toFix > 0 ? problems.focusFirst() : void act.run('post', postIt)())}
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

const freeLine = (): Line => ({
  item: { id: null, code: null, name: null, allowsFraction: false },
  receiptLineId: null,
  returnable: null,
  qty: '',
  unitCost: '',
});
