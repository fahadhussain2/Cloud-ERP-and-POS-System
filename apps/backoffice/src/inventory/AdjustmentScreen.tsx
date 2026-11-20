import type { AdjustmentView, InventoryItem, InventoryLookups, StockDocumentRow } from '@erp/contracts';
import { adjustmentApproval, checkAdjustment, isEmptyDraft } from '@erp/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  formatMoney,
  Input,
  LABEL_CLASS,
  PageHeader,
  Panel,
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
import { qtyText, qtyValue } from '../catalog/data';
import { ItemPicker } from '../purchasing/ItemPicker';
import { carry, href, navigate, takeCarried } from '../router';
import { dateProblem, inventoryRefusal, locationName, problemText, useInventoryLookups } from './data';
import { StatusOf } from './TransferScreen';

// Stock adjustments (W1-18, INV-05; owner answers 1 and 3): found (+) or gone (−) at one location, with a reason,
// valued at the average and posted against Inventory adjustments. A loss above the shop's limit, posted by someone
// who can't approve it, waits for the owner, who approves it or sends it back with a note. The value shows before
// posting, for those who may see costs.

export function AdjustmentsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = useInventoryLookups(api);
  const [list, setList] = useState<StockDocumentRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/inventory/adjustments').then(
      (r) =>
        live && setList(r.status === 200 ? (r.body as { adjustments: StockDocumentRow[] }).adjustments : []),
    );
    return () => {
      live = false;
    };
  }, [api]);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader
        title={t('inventory.adjustments.title')}
        help={t('inventory.adjustments.help')}
        actions={
          lookups.can.adjust && (
            <Button asChild size="lg">
              <a href={href.adjustment('new')}>{t('inventory.adjustments.add')}</a>
            </Button>
          )
        }
      />
      <Panel className="px-1.5 pb-2.5">
        {list === null ? (
          <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
        ) : list.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('inventory.adjustments.empty')}</p>
        ) : (
          <Table aria-label={t('inventory.adjustments.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('inventory.fields.number')}</TableHead>
                <TableHead>{t('inventory.fields.date')}</TableHead>
                <TableHead>{t('inventory.fields.location')}</TableHead>
                <TableHead>{t('inventory.fields.reason')}</TableHead>
                <TableHead className="text-end">{t('inventory.fields.loss')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <a
                      href={href.adjustment(d.id)}
                      className="font-mono font-semibold text-ink underline-offset-4 hover:underline"
                    >
                      {d.number ?? t('inventory.unnumbered')}
                    </a>{' '}
                    <StatusOf status={d.status} />
                  </TableCell>
                  <TableCell>{d.date}</TableCell>
                  <TableCell>{locationName(lookups, d.locationId, t)}</TableCell>
                  <TableCell>{d.reason ? t(`inventory.reasons.${d.reason}`) : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {d.lossValue === null ? '—' : formatMoney(d.lossValue, lookups.money)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}

interface Line {
  item: { id: string | null; code: string | null; name: string | null; allowsFraction: boolean };
  stock: Record<string, number> | null;
  avgCost: number | null;
  qty: string;
}

const blank = (): Line => ({
  item: { id: null, code: null, name: null, allowsFraction: false },
  stock: null,
  avgCost: null,
  qty: '',
});

export function AdjustmentScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = useInventoryLookups(api);
  const isNew = id === 'new';
  const [view, setView] = useState<AdjustmentView | null | undefined>(isNew ? null : undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    if (!isNew)
      void api('GET', `/api/inventory/adjustments/${encodeURIComponent(id)}`).then(
        (r) => live && setView(r.status === 200 ? (r.body as AdjustmentView) : null),
      );
    return () => {
      live = false;
    };
  }, [api, id, isNew, version]);
  const back = (
    <a
      href={href.adjustments}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('inventory.adjustments.title')}
    </a>
  );
  if (lookups === null || view === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (view === null && !isNew)
    return <PageHeader eyebrow={back} title={t('inventory.adjustments.notFound')} />;
  return (
    <AdjustmentForm
      key={view?.adjustment.rowVersion ?? 'new'}
      api={api}
      lookups={lookups}
      view={view}
      back={back}
      onSaved={() => setVersion((v) => v + 1)}
    />
  );
}

function AdjustmentForm({
  api,
  lookups,
  view,
  back,
  onSaved,
}: {
  api: Api;
  lookups: InventoryLookups;
  view: AdjustmentView | null;
  back: ReactNode;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const m = lookups.money;
  const a = view?.adjustment;
  const draft = !a || a.status === 'draft';
  const canEdit = lookups.can.adjust && draft;
  // A shortfall on arrival is at In transit, which isn't one of the locations to pick.
  const fixedAt = a !== undefined && !lookups.locations.some((l) => l.id === a.locationId);
  const [h, setH] = useState({
    locationId: a?.locationId ?? lookups.locations.find((l) => l.kind === 'shop')?.id ?? '',
    adjustedOn: a?.adjustedOn ?? lookups.today,
    reason: a?.reason ?? '',
    note: a?.note ?? '',
  });
  const [lines, setLines] = useState<Line[]>(
    view
      ? view.lines.map((l) => ({
          item: { id: l.itemId, code: l.code, name: l.name, allowsFraction: l.allowsFraction },
          stock: l.onHand === null ? null : { [view.adjustment.locationId]: l.onHand },
          avgCost: l.avgCost,
          qty: qtyText(l.qty),
        }))
      : [blank()],
  );
  const [rejectNote, setRejectNote] = useState('');
  // A refusal from just before this form opened (a new draft at its own address, or a reload): see `carry`.
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(() => {
    const text = takeCarried(href.adjustment(a?.id ?? 'new'));
    return text === null ? null : { text, error: true };
  });
  const ids = { location: useId(), reason: useId() };
  const exists = (k: string) => t(k) !== k;
  const set = (k: keyof typeof h, v: string) => setH((s) => ({ ...s, [k]: v }));
  const put = (n: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const nan = (v: number | null | undefined) => (v === undefined ? Number.NaN : (v ?? 0));
  const used = lines.filter((l) => l.item.id !== null || l.qty.trim() !== '');
  // The owner can't approve one dated on or before the lock date either.
  const approveLocked = a ? dateProblem(t, a.adjustedOn, lookups) : null;
  // A date after the shop's business date (W2-05) or on or before the lock date (D-108) can't post: Post waits, and
  // the date says why. Save draft still works.
  const locked = dateProblem(t, h.adjustedOn, lookups);
  const check = checkAdjustment({
    locationId: h.locationId || null,
    locationKind: fixedAt ? 'transit' : (lookups.locations.find((l) => l.id === h.locationId)?.kind ?? null),
    reason: h.reason || null,
    note: h.note,
    lines: used.map((l) => ({
      itemId: l.item.id,
      qty: nan(qtyValue(l.qty)),
      allowsFraction: l.item.allowsFraction,
      onHand: l.stock === null ? null : (l.stock[h.locationId] ?? 0),
    })),
  });
  const value =
    check.problems.some((p) => p.row !== null) || !lookups.can.viewCost
      ? null
      : adjustmentApproval({
          canApprove: lookups.can.approve,
          limit: lookups.adjustmentApprovalLimit,
          lines: used.map((l) => ({ qty: qtyValue(l.qty) ?? 0, avgCost: l.avgCost })),
        });
  // Without cost.view the screen can't value it: the server's view says whether it would wait.
  const waits = value ? value.needsApproval : (view?.needsApproval ?? false);

  const body = () => ({
    locationId: h.locationId || null,
    adjustedOn: h.adjustedOn,
    reason: h.reason || null,
    note: h.note,
    lines: used.map((l) => ({ itemId: l.item.id, qty: qtyValue(l.qty) ?? 0 })),
  });
  const save = async (): Promise<{ id: string; rowVersion: string } | null> => {
    // Nothing on any line is nothing to keep (owner's review of W1-19); the server refuses it too.
    if (isEmptyDraft(body().lines)) {
      setMessage({ text: t('inventory.errors.empty_draft'), error: true });
      return null;
    }
    const res = a
      ? await api('PUT', `/api/inventory/adjustments/${encodeURIComponent(a.id)}`, {
          ...body(),
          rowVersion: a.rowVersion,
        })
      : await api('POST', '/api/inventory/adjustments', body());
    if (res.status === 200) return { id: a!.id, rowVersion: (res.body as { rowVersion: string }).rowVersion };
    if (res.status === 201) return res.body as { id: string; rowVersion: string };
    setMessage({ text: inventoryRefusal(t, exists, res.body), error: true });
    return null;
  };
  const after = (id: string) => {
    if (!a) navigate(href.adjustment(id));
    else onSaved();
  };
  const postIt = async () => {
    const s = await save();
    if (!s) return;
    const res = await api('POST', `/api/inventory/adjustments/${encodeURIComponent(s.id)}/post`, {
      rowVersion: s.rowVersion,
    });
    // The draft was saved before Post was refused: it opens again, as saved, with the refusal (`carry`).
    if (res.status !== 200) {
      const text = inventoryRefusal(t, exists, res.body);
      setMessage({ text, error: true });
      carry(href.adjustment(s.id), text);
    }
    after(s.id);
  };
  const decide = async (what: 'approve' | 'reject') => {
    const res = await api('POST', `/api/inventory/adjustments/${encodeURIComponent(a!.id)}/${what}`, {
      rowVersion: a!.rowVersion,
      ...(what === 'reject' ? { note: rejectNote } : {}),
    });
    if (res.status !== 200) setMessage({ text: inventoryRefusal(t, exists, res.body), error: true });
    else onSaved();
  };

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={a?.number ?? (a ? t('inventory.unnumbered') : t('inventory.adjustments.new'))}
        help={
          <span className="flex flex-wrap items-center gap-2">
            {a && <StatusOf status={a.status} />}
            {a?.transfer && (
              <a href={href.transfer(a.transfer.id)} className="underline">
                {t('inventory.adjustments.ofTransfer', { number: a.transfer.number })}
              </a>
            )}
            {a?.approvedBy && t('inventory.adjustments.approvedBy', { name: a.approvedBy })}
          </span>
        }
      />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      {a?.rejection && draft && (
        <Alert variant="destructive">
          <AlertTitle>{t('inventory.adjustments.rejected', { name: a.rejection.by ?? '—' })}</AlertTitle>
          <AlertDescription>{a.rejection.note}</AlertDescription>
        </Alert>
      )}
      {a?.status === 'awaiting_approval' && (
        <Alert>
          <AlertTitle>{t('inventory.adjustments.awaiting', { name: a.submittedBy ?? '—' })}</AlertTitle>
          <AlertDescription>{t('inventory.adjustments.awaitingHelp')}</AlertDescription>
        </Alert>
      )}
      <Panel>
        <fieldset disabled={!canEdit} className="m-0 grid grid-cols-1 gap-3.5 border-0 p-3.5 md:grid-cols-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.location} className={LABEL_CLASS}>
              {t('inventory.fields.location')}
            </label>
            <select
              id={ids.location}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.locationId}
              disabled={fixedAt}
              onChange={(e) => set('locationId', e.target.value)}
            >
              {fixedAt && <option value={h.locationId}>{t('inventory.inTransit')}</option>}
              {lookups.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('inventory.fields.adjustedOn')}
            type="date"
            error={locked}
            max={lookups.today}
            value={h.adjustedOn}
            onChange={(e) => set('adjustedOn', e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.reason} className={LABEL_CLASS}>
              {t('inventory.fields.reason')}
            </label>
            <select
              id={ids.reason}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={h.reason}
              onChange={(e) => set('reason', e.target.value)}
            >
              <option value="">—</option>
              {lookups.reasons.map((r) => (
                <option key={r} value={r}>
                  {t(`inventory.reasons.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('inventory.fields.note')}
            value={h.note}
            onChange={(e) => set('note', e.target.value)}
          />
        </fieldset>
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('inventory.adjustments.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[45%]">{t('inventory.line.item')}</TableHead>
              {draft && <TableHead className="text-end">{t('inventory.line.onHand')}</TableHead>}
              <TableHead>{t('inventory.line.change')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const row = used.indexOf(l);
              const notes = row < 0 ? [] : check.problems.filter((p) => p.row === row);
              const below = row >= 0 && check.warnings.some((w) => w.row === row);
              return (
                <TableRow key={i} className="align-top">
                  <TableCell>
                    <ItemPicker<InventoryItem>
                      api={api}
                      url="/api/inventory/items"
                      label={t('inventory.line.itemOf', { row: i + 1 })}
                      picked={l.item}
                      disabled={!canEdit}
                      onPick={(item) => put(i, { item, stock: item.stock, avgCost: item.avgCost })}
                    />
                    {notes.map((p, k) => (
                      <p key={k} className="m-0 mt-1 text-xs text-destructive">
                        {problemText(t, exists, p.problem, null)}
                      </p>
                    ))}
                    {below && (
                      <p className="m-0 mt-1 text-xs text-warn">{t('inventory.warnings.below_zero')}</p>
                    )}
                  </TableCell>
                  {draft && (
                    <TableCell className="text-end leading-9 tabular-nums">
                      {l.stock === null ? '—' : qtyText(l.stock[h.locationId] ?? 0)}
                    </TableCell>
                  )}
                  <TableCell>
                    <Input
                      aria-label={t('inventory.line.changeOf', { row: i + 1 })}
                      className="h-9 w-24"
                      inputMode="decimal"
                      placeholder="-1"
                      disabled={!canEdit}
                      value={l.qty}
                      onChange={(e) => put(i, { qty: e.target.value })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {canEdit && (
          <div className="px-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => setLines([...lines, blank()])}>
              {t('inventory.line.add')}
            </Button>
          </div>
        )}
        {value && (
          <p className="m-0 px-2 pt-2 text-end font-semibold" role="status">
            {t('inventory.adjustments.value', {
              gain: formatMoney(value.gain, m),
              loss: formatMoney(value.loss, m),
            })}
          </p>
        )}
      </Panel>
      {draft && check.problems.some((p) => p.row === null) && (
        <p className="m-0 text-sm text-muted-foreground">
          {check.problems
            .filter((p) => p.row === null)
            .map((p) => problemText(t, exists, p.problem, null))
            .join(' ')}
        </p>
      )}
      {canEdit && waits && (
        <p className="m-0 text-sm font-medium">
          {t('inventory.adjustments.willWait', { limit: formatMoney(lookups.adjustmentApprovalLimit, m) })}
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() =>
              void save().then((s) => {
                if (s) {
                  setMessage({ text: t('inventory.saved'), error: false });
                  after(s.id);
                }
              })
            }
          >
            {t('inventory.saveDraft')}
          </Button>
          <Button onClick={() => void postIt()} disabled={check.problems.length > 0 || locked !== null}>
            {waits ? t('inventory.adjustments.sendForApproval') : t('inventory.post')}
          </Button>
        </div>
      )}
      {a?.status === 'awaiting_approval' && lookups.can.approve && (
        <Panel className="flex flex-wrap items-end gap-3 p-3.5">
          <Button onClick={() => void decide('approve')} disabled={approveLocked !== null}>
            {t('inventory.adjustments.approve')}
          </Button>
          {approveLocked && <span className="text-sm text-destructive">{approveLocked}</span>}
          <TextField
            label={t('inventory.adjustments.rejectNote')}
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            wrapperClassName="min-w-64 flex-1"
          />
          <Button variant="outline" disabled={rejectNote.trim() === ''} onClick={() => void decide('reject')}>
            {t('inventory.adjustments.reject')}
          </Button>
        </Panel>
      )}
    </>
  );
}
