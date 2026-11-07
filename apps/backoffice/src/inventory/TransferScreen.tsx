import type {
  InventoryItem,
  InventoryLookups,
  StockDocumentRow,
  TransferNeededRow,
  TransferView,
} from '@erp/contracts';
import { checkTransfer } from '@erp/domain';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
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
  type ChipTone,
} from '@erp/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText, qtyValue } from '../catalog/data';
import { ItemPicker } from '../purchasing/ItemPicker';
import { href, navigate } from '../router';
import { inventoryRefusal, locationName, problemText, today, useInventoryLookups } from './data';

// Stock transfers (W1-18, INV-04; owner answers 2 and 4): the storekeeper types one, the owner or the manager posts
// it. On a route that moves at once posting moves the stock; on one that needs receiving it is sent, on the way until
// someone receives what arrived. Stock may go below 0: the screen warns, it still posts (INV-03).

/** Until go-live stock is moved in the legacy app; practice transfers are removed by the pilot wipe. */
export function StockNotice({ lookups }: { lookups: InventoryLookups }) {
  const { t } = useTranslation();
  if (lookups.live) return null;
  return (
    <Alert>
      <AlertTitle>{t('inventory.notLive.title')}</AlertTitle>
      <AlertDescription>{t('inventory.notLive.text')}</AlertDescription>
    </Alert>
  );
}

const TONE: Record<string, ChipTone> = {
  draft: 'warn',
  in_transit: 'accent',
  awaiting_approval: 'accent',
  posted: 'ok',
  received: 'ok',
};

export function StatusOf({ status }: { status: string }) {
  const { t } = useTranslation();
  return <StatusChip tone={TONE[status] ?? 'neutral'}>{t(`inventory.status.${status}`)}</StatusChip>;
}

export function TransfersScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = useInventoryLookups(api);
  const [filter, setFilter] = useState<'' | 'in_transit' | 'draft'>('');
  const [list, setList] = useState<StockDocumentRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/inventory/transfers${filter ? `?status=${filter}` : ''}`).then(
      (r) => live && setList(r.status === 200 ? (r.body as { transfers: StockDocumentRow[] }).transfers : []),
    );
    return () => {
      live = false;
    };
  }, [api, filter]);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader
        title={t('inventory.transfers.title')}
        help={t('inventory.transfers.help')}
        actions={
          lookups.can.transfer && (
            <Button asChild size="lg">
              <a href={href.transfer('new')}>{t('inventory.transfers.add')}</a>
            </Button>
          )
        }
      />
      <StockNotice lookups={lookups} />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('inventory.transfers.show')}>
        {(['', 'in_transit', 'draft'] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? 'default' : 'outline'}
            onClick={() => setFilter(f)}
          >
            {t(`inventory.transfers.filter.${f || 'all'}`)}
          </Button>
        ))}
      </div>
      <Panel className="px-1.5 pb-2.5">
        {list === null ? (
          <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
        ) : list.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('inventory.transfers.empty')}</p>
        ) : (
          <Table aria-label={t('inventory.transfers.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('inventory.fields.number')}</TableHead>
                <TableHead>{t('inventory.fields.date')}</TableHead>
                <TableHead>{t('inventory.fields.from')}</TableHead>
                <TableHead>{t('inventory.fields.to')}</TableHead>
                <TableHead className="text-end">{t('inventory.fields.lines')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <a
                      href={href.transfer(d.id)}
                      className="font-mono font-semibold text-ink underline-offset-4 hover:underline"
                    >
                      {d.number ?? t('inventory.unnumbered')}
                    </a>{' '}
                    <StatusOf status={d.status} />
                  </TableCell>
                  <TableCell>{d.date}</TableCell>
                  <TableCell>{locationName(lookups, d.fromLocationId, t)}</TableCell>
                  <TableCell>{locationName(lookups, d.toLocationId, t)}</TableCell>
                  <TableCell className="text-end tabular-nums">{d.lines}</TableCell>
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
  /** What the from location has, from the pick or the saved view; null = not known. */
  stock: Record<string, number> | null;
  qty: string;
}

const blank = (): Line => ({
  item: { id: null, code: null, name: null, allowsFraction: false },
  stock: null,
  qty: '',
});

/** `id` is a transfer's id, `new`, or `needed` for a new Godown → Shop transfer of everything Transfer needed lists. */
export function TransferScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = useInventoryLookups(api);
  const isNew = id === 'new' || id === 'needed';
  const [view, setView] = useState<TransferView | null | undefined>(isNew ? null : undefined);
  const [needed, setNeeded] = useState<TransferNeededRow[] | null | undefined>(
    id === 'needed' ? undefined : null,
  );
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    if (!isNew)
      void api('GET', `/api/inventory/transfers/${encodeURIComponent(id)}`).then(
        (r) => live && setView(r.status === 200 ? (r.body as TransferView) : null),
      );
    if (id === 'needed')
      void api('GET', '/api/inventory/transfer-needed').then(
        (r) => live && setNeeded(r.status === 200 ? (r.body as { rows: TransferNeededRow[] }).rows : []),
      );
    return () => {
      live = false;
    };
  }, [api, id, isNew, version]);

  const back = (
    <a
      href={href.transfers}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('inventory.transfers.title')}
    </a>
  );
  if (lookups === null || view === undefined || needed === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (view === null && !isNew) return <PageHeader eyebrow={back} title={t('inventory.transfers.notFound')} />;
  return (
    <TransferForm
      key={view?.transfer.rowVersion ?? 'new'}
      api={api}
      lookups={lookups}
      view={view}
      needed={needed}
      back={back}
      onSaved={() => setVersion((v) => v + 1)}
    />
  );
}

function TransferForm({
  api,
  lookups,
  view,
  needed,
  back,
  onSaved,
}: {
  api: Api;
  lookups: InventoryLookups;
  view: TransferView | null;
  needed: TransferNeededRow[] | null;
  back: ReactNode;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const x = view?.transfer;
  const draft = !x || x.status === 'draft';
  const canEdit = lookups.can.transfer && draft;
  const byKind = (kind: string) => lookups.locations.find((l) => l.kind === kind)?.id ?? '';
  const [h, setH] = useState({
    fromLocationId: x?.fromLocationId ?? byKind('storage'),
    toLocationId: x?.toLocationId ?? byKind('shop'),
    movedOn: x?.movedOn ?? today(),
    note: x?.note ?? '',
  });
  const [lines, setLines] = useState<Line[]>(
    view
      ? view.lines.map((l) => ({
          item: { id: l.itemId, code: l.code, name: l.name, allowsFraction: l.allowsFraction },
          stock: l.available === null ? null : { [view.transfer.fromLocationId]: l.available },
          qty: qtyText(l.qty),
        }))
      : needed && needed.length > 0
        ? needed.map((n) => ({
            item: { id: n.itemId, code: n.code, name: n.name, allowsFraction: true },
            stock: { [byKind('storage')]: n.godown },
            qty: qtyText(n.suggested),
          }))
        : [blank()],
  );
  const [received, setReceived] = useState<string[]>(view ? view.lines.map((l) => qtyText(l.qty)) : []);
  const [receivedOn, setReceivedOn] = useState(today());
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const ids = { from: useId(), to: useId() };
  const exists = (k: string) => t(k) !== k;
  const set = (k: keyof typeof h, v: string) => setH((s) => ({ ...s, [k]: v }));
  const put = (n: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, i) => (i === n ? { ...l, ...patch } : l)));
  const nan = (v: number | null | undefined) => (v === undefined ? Number.NaN : (v ?? 0));
  const kind = (id: string) => lookups.locations.find((l) => l.id === id)?.kind ?? null;
  const used = lines.filter((l) => l.item.id !== null || l.qty.trim() !== '');
  const check = checkTransfer({
    fromLocationId: h.fromLocationId || null,
    toLocationId: h.toLocationId || null,
    fromKind: kind(h.fromLocationId),
    toKind: kind(h.toLocationId),
    lines: used.map((l) => ({
      itemId: l.item.id,
      qty: nan(qtyValue(l.qty)),
      allowsFraction: l.item.allowsFraction,
      available: l.stock === null ? null : (l.stock[h.fromLocationId] ?? 0),
    })),
  });
  const needsReceiving = draft
    ? lookups.routes.some(
        (r) => r.fromLocationId === h.fromLocationId && r.toLocationId === h.toLocationId && r.needsReceiving,
      )
    : x.needsReceiving;

  const body = () => ({
    fromLocationId: h.fromLocationId || null,
    toLocationId: h.toLocationId || null,
    movedOn: h.movedOn,
    note: h.note,
    lines: used.map((l) => ({ itemId: l.item.id, qty: qtyValue(l.qty) ?? 0 })),
  });
  const save = async (): Promise<{ id: string; rowVersion: string } | null> => {
    const res = x
      ? await api('PUT', `/api/inventory/transfers/${encodeURIComponent(x.id)}`, {
          ...body(),
          rowVersion: x.rowVersion,
        })
      : await api('POST', '/api/inventory/transfers', body());
    if (res.status === 200) return { id: x!.id, rowVersion: (res.body as { rowVersion: string }).rowVersion };
    if (res.status === 201) return res.body as { id: string; rowVersion: string };
    setMessage({ text: inventoryRefusal(t, exists, res.body), error: true });
    return null;
  };
  const after = (id: string) => {
    if (!x) navigate(href.transfer(id));
    else onSaved();
  };
  const postIt = async () => {
    const s = await save();
    if (!s) return;
    const res = await api('POST', `/api/inventory/transfers/${encodeURIComponent(s.id)}/post`, {
      rowVersion: s.rowVersion,
    });
    if (res.status !== 200) setMessage({ text: inventoryRefusal(t, exists, res.body), error: true });
    after(s.id);
  };
  const receiveIt = async () => {
    const res = await api('POST', `/api/inventory/transfers/${encodeURIComponent(x!.id)}/receive`, {
      rowVersion: x!.rowVersion,
      receivedOn,
      lines: view!.lines.map((l, i) => ({ lineId: l.id, receivedQty: qtyValue(received[i] ?? '') ?? 0 })),
    });
    if (res.status !== 200) setMessage({ text: inventoryRefusal(t, exists, res.body), error: true });
    else onSaved();
  };

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={x?.number ?? (x ? t('inventory.unnumbered') : t('inventory.transfers.new'))}
        help={
          <span className="flex flex-wrap items-center gap-2">
            {x && <StatusOf status={x.status} />}
            {x?.postedBy && t('inventory.transfers.postedBy', { name: x.postedBy })}
            {x?.receivedBy && t('inventory.transfers.receivedBy', { name: x.receivedBy, date: x.receivedOn })}
          </span>
        }
      />
      <StockNotice lookups={lookups} />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      {view?.shortfallAdjustment && (
        <Alert>
          <AlertDescription>
            {t('inventory.transfers.shortfall')}{' '}
            <a href={href.adjustment(view.shortfallAdjustment.id)} className="font-semibold underline">
              {view.shortfallAdjustment.number ?? t('inventory.draft')}
            </a>
          </AlertDescription>
        </Alert>
      )}
      <Panel>
        <fieldset disabled={!canEdit} className="m-0 grid gap-3.5 border-0 p-3.5 md:grid-cols-4">
          {(['from', 'to'] as const).map((side) => (
            <div key={side} className="flex flex-col gap-1.5">
              <label htmlFor={ids[side]} className={LABEL_CLASS}>
                {t(`inventory.fields.${side}`)}
              </label>
              <select
                id={ids[side]}
                className="h-11 rounded-md border border-input bg-surface-2 px-2"
                value={side === 'from' ? h.fromLocationId : h.toLocationId}
                onChange={(e) => set(side === 'from' ? 'fromLocationId' : 'toLocationId', e.target.value)}
              >
                {lookups.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <TextField
            label={t('inventory.fields.movedOn')}
            type="date"
            value={h.movedOn}
            onChange={(e) => set('movedOn', e.target.value)}
          />
          <TextField
            label={t('inventory.fields.note')}
            value={h.note}
            onChange={(e) => set('note', e.target.value)}
          />
        </fieldset>
        {draft && needsReceiving && (
          <p className="m-0 px-3.5 pb-3 text-sm text-muted-foreground">
            {t('inventory.transfers.needsReceiving')}
          </p>
        )}
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('inventory.transfers.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[45%]">{t('inventory.line.item')}</TableHead>
              {draft && <TableHead className="text-end">{t('inventory.line.available')}</TableHead>}
              <TableHead>{t('inventory.line.qty')}</TableHead>
              {x?.status === 'in_transit' && <TableHead>{t('inventory.line.received')}</TableHead>}
              {x?.status === 'received' && (
                <TableHead className="text-end">{t('inventory.line.received')}</TableHead>
              )}
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
                      onPick={(item) => put(i, { item, stock: item.stock })}
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
                      {l.stock === null ? '—' : qtyText(l.stock[h.fromLocationId] ?? 0)}
                    </TableCell>
                  )}
                  <TableCell>
                    <Input
                      aria-label={t('inventory.line.qtyOf', { row: i + 1 })}
                      className="h-9 w-24"
                      inputMode="decimal"
                      disabled={!canEdit}
                      value={l.qty}
                      onChange={(e) => put(i, { qty: e.target.value })}
                    />
                  </TableCell>
                  {x?.status === 'in_transit' && (
                    <TableCell>
                      <Input
                        aria-label={t('inventory.line.receivedOf', { row: i + 1 })}
                        className="h-9 w-24"
                        inputMode="decimal"
                        disabled={!lookups.can.postTransfer}
                        value={received[i] ?? ''}
                        onChange={(e) => setReceived((r) => r.map((v, k) => (k === i ? e.target.value : v)))}
                      />
                    </TableCell>
                  )}
                  {x?.status === 'received' && (
                    <TableCell className="text-end leading-9 tabular-nums">
                      {qtyText(view!.lines[i]?.receivedQty ?? 0)}
                    </TableCell>
                  )}
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
      </Panel>
      {draft && check.problems.some((p) => p.row === null) && (
        <p className="m-0 text-sm text-muted-foreground">
          {check.problems
            .filter((p) => p.row === null)
            .map((p) => problemText(t, exists, p.problem, null))
            .join(' ')}
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
          {lookups.can.postTransfer && (
            <Button onClick={() => void postIt()} disabled={check.problems.length > 0}>
              {needsReceiving ? t('inventory.transfers.send') : t('inventory.post')}
            </Button>
          )}
        </div>
      )}
      {x?.status === 'in_transit' && lookups.can.postTransfer && (
        <Panel className="flex flex-wrap items-end gap-3 p-3.5">
          <TextField
            label={t('inventory.fields.receivedOn')}
            type="date"
            value={receivedOn}
            onChange={(e) => setReceivedOn(e.target.value)}
          />
          <Button onClick={() => void receiveIt()}>{t('inventory.transfers.receive')}</Button>
          <span className="text-sm text-muted-foreground">{t('inventory.transfers.receiveHint')}</span>
        </Panel>
      )}
    </>
  );
}
