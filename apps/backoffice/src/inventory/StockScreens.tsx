import type { InventoryItem, InventoryLookups, StockCardView, TransferNeededRow } from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  formatMoney,
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
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyText, moneyValue, qtyText } from '../catalog/data';
import { ItemPicker } from '../purchasing/ItemPicker';
import { href, navigate } from '../router';
import { inventoryRefusal, locationName, useInventoryLookups } from './data';
import { StockNotice } from './TransferScreen';

// Reading and setting up the stock (W1-18): an item's stock card (INV-07), Transfer needed (PRD W13) and the owner's
// stock settings (owner answers 3 and 4).

/** Where a movement's document opens, when it is one of the back office's. */
function documentHref(kind: string, id: string): string | null {
  if (kind === 'stock_transfer' || kind === 'stock_transfer_receipt') return href.transfer(id);
  if (kind === 'stock_adjustment') return href.adjustment(id);
  if (kind === 'goods_receipt') return href.receipt(id);
  if (kind === 'purchase_return') return href.purchaseReturn(id);
  return null;
}

/** `itemId` null: pick an item first. */
export function StockCardScreen({ api, itemId }: { api: Api; itemId: string | null }) {
  const { t } = useTranslation();
  const lookups = useInventoryLookups(api);
  const [location, setLocation] = useState('');
  const [pages, setPages] = useState<StockCardView[] | null>(null);
  const locId = useId();
  useEffect(() => {
    if (itemId === null) return;
    let live = true;
    const q = location ? `?location=${encodeURIComponent(location)}` : '';
    void api('GET', `/api/inventory/items/${encodeURIComponent(itemId)}/card${q}`).then(
      (r) => live && setPages(r.status === 200 ? [r.body as StockCardView] : []),
    );
    return () => {
      live = false;
    };
  }, [api, itemId, location]);
  const older = async () => {
    const last = pages!.at(-1)!;
    const q = new URLSearchParams({ before: String(last.next) });
    if (location) q.set('location', location);
    const r = await api('GET', `/api/inventory/items/${encodeURIComponent(itemId!)}/card?${q.toString()}`);
    if (r.status === 200) setPages([...pages!, r.body as StockCardView]);
  };
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const card = pages?.[0];
  const movements = (pages ?? []).flatMap((p) => p.movements);
  const m = lookups.money;
  const name = (id: string) => locationName(lookups, id, t);
  return (
    <>
      <PageHeader
        title={card ? `${card.item.code} ${card.item.name}` : t('inventory.card.title')}
        help={t('inventory.card.help')}
      />
      <Panel className="flex flex-wrap items-end gap-3 p-3.5">
        <div className="w-96 max-w-full">
          <span className={LABEL_CLASS}>{t('inventory.card.item')}</span>
          <ItemPicker<InventoryItem>
            api={api}
            url="/api/inventory/items"
            label={t('inventory.card.item')}
            picked={card ? card.item : null}
            onPick={(item) => navigate(href.stockCard(item.id))}
          />
        </div>
        {itemId !== null && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={locId} className={LABEL_CLASS}>
              {t('inventory.fields.location')}
            </label>
            <select
              id={locId}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            >
              <option value="">{t('inventory.card.everywhere')}</option>
              {lookups.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </Panel>
      {card && (
        <p className="m-0 text-sm" role="status">
          {Object.keys(card.balances).length === 0
            ? t('inventory.card.none')
            : Object.entries(card.balances)
                .map(([l, q]) => `${name(l)}: ${qtyText(q)}`)
                .join(' · ')}
        </p>
      )}
      {itemId !== null && (
        <Panel className="px-1.5 pb-2.5">
          {pages === null ? (
            <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
          ) : movements.length === 0 ? (
            <p className="p-2 text-muted-foreground">{t('inventory.card.empty')}</p>
          ) : (
            <Table aria-label={t('inventory.card.movements')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('inventory.fields.date')}</TableHead>
                  <TableHead>{t('inventory.card.document')}</TableHead>
                  <TableHead>{t('inventory.fields.location')}</TableHead>
                  <TableHead className="text-end">{t('inventory.card.in')}</TableHead>
                  <TableHead className="text-end">{t('inventory.card.out')}</TableHead>
                  {lookups.can.viewCost && (
                    <TableHead className="text-end">{t('inventory.card.cost')}</TableHead>
                  )}
                  {lookups.can.viewCost && (
                    <TableHead className="text-end">{t('inventory.card.value')}</TableHead>
                  )}
                  <TableHead className="text-end">{t('inventory.card.balance')}</TableHead>
                  <TableHead className="text-end">{t('inventory.card.total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((v, i) => {
                  const link = documentHref(v.kind, v.documentId);
                  const label = v.number ?? t(`inventory.card.kinds.${v.kind}`, { defaultValue: v.kind });
                  return (
                    <TableRow key={`${v.seq}-${i}`}>
                      <TableCell>{v.date}</TableCell>
                      <TableCell>
                        {link ? (
                          <a
                            href={link}
                            className="font-mono font-semibold underline-offset-4 hover:underline"
                          >
                            {label}
                          </a>
                        ) : (
                          <span className="font-mono">{label}</span>
                        )}
                      </TableCell>
                      <TableCell>{name(v.locationId)}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {v.qty > 0 ? qtyText(v.qty) : ''}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {v.qty < 0 ? qtyText(-v.qty) : ''}
                      </TableCell>
                      {lookups.can.viewCost && (
                        <TableCell className="text-end tabular-nums">
                          {v.unitCost === null ? '—' : formatMoney(v.unitCost, m)}
                        </TableCell>
                      )}
                      {lookups.can.viewCost && (
                        <TableCell className="text-end tabular-nums">
                          {v.value === null ? '—' : formatMoney(v.value, m)}
                        </TableCell>
                      )}
                      <TableCell className="text-end tabular-nums">{qtyText(v.balance)}</TableCell>
                      <TableCell className="text-end tabular-nums">{qtyText(v.total)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {pages?.at(-1)?.next != null && (
            <div className="px-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => void older()}>
                {t('inventory.card.older')}
              </Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

export function TransferNeededScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = useInventoryLookups(api);
  const [rows, setRows] = useState<TransferNeededRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/inventory/transfer-needed').then(
      (r) => live && setRows(r.status === 200 ? (r.body as { rows: TransferNeededRow[] }).rows : []),
    );
    return () => {
      live = false;
    };
  }, [api]);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader
        title={t('inventory.needed.title')}
        help={t('inventory.needed.help')}
        actions={
          lookups.can.transfer &&
          rows !== null &&
          rows.length > 0 && (
            <Button asChild size="lg">
              <a href={href.transfer('needed')}>{t('inventory.needed.transfer')}</a>
            </Button>
          )
        }
      />
      <StockNotice lookups={lookups} />
      <Panel className="px-1.5 pb-2.5">
        {rows === null ? (
          <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('inventory.needed.empty')}</p>
        ) : (
          <Table aria-label={t('inventory.needed.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('inventory.line.item')}</TableHead>
                <TableHead className="text-end">{t('inventory.needed.shop')}</TableHead>
                <TableHead className="text-end">{t('inventory.needed.godown')}</TableHead>
                <TableHead className="text-end">{t('inventory.needed.suggested')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.itemId}>
                  <TableCell>
                    <a
                      href={href.stockCard(r.itemId)}
                      className="font-mono font-semibold underline-offset-4 hover:underline"
                    >
                      {r.code}
                    </a>{' '}
                    {r.name}
                  </TableCell>
                  <TableCell className="text-end tabular-nums text-destructive">{qtyText(r.shop)}</TableCell>
                  <TableCell className="text-end tabular-nums">{qtyText(r.godown)}</TableCell>
                  <TableCell className="text-end font-semibold tabular-nums">
                    {qtyText(r.suggested)}
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

export function StockSettingsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const lookups = useInventoryLookups(api, version);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return <SettingsForm key={version} api={api} lookups={lookups} onSaved={() => setVersion((v) => v + 1)} />;
}

function SettingsForm({
  api,
  lookups,
  onSaved,
}: {
  api: Api;
  lookups: InventoryLookups;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const m = lookups.money;
  const [limit, setLimit] = useState(moneyText(lookups.adjustmentApprovalLimit, m.minorUnits));
  const key = (from: string, to: string) => `${from}>${to}`;
  const [receiving, setReceiving] = useState(
    new Set(lookups.routes.filter((r) => r.needsReceiving).map((r) => key(r.fromLocationId, r.toLocationId))),
  );
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const exists = (k: string) => t(k) !== k;
  const value = moneyValue(limit, m.minorUnits);
  const locs = lookups.locations;
  const save = async () => {
    const res = await api('PUT', '/api/inventory/settings', {
      adjustmentApprovalLimit: value ?? 0,
      routes: [...receiving].map((k) => {
        const [fromLocationId, toLocationId] = k.split('>');
        return { fromLocationId, toLocationId, needsReceiving: true };
      }),
    });
    if (res.status !== 200) setMessage({ text: inventoryRefusal(t, exists, res.body), error: true });
    else onSaved();
  };
  return (
    <>
      <PageHeader title={t('inventory.settings.title')} help={t('inventory.settings.help')} />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <Panel className="flex flex-col gap-1.5 p-3.5">
        <TextField
          label={t('inventory.settings.limit')}
          inputMode="decimal"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          wrapperClassName="w-56"
        />
        <p className="m-0 text-sm text-muted-foreground">{t('inventory.settings.limitHelp')}</p>
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <p className="m-0 px-2 pt-2 text-sm text-muted-foreground">{t('inventory.settings.routesHelp')}</p>
        <Table aria-label={t('inventory.settings.routes')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('inventory.fields.from')}</TableHead>
              {locs.map((to) => (
                <TableHead key={to.id} className="text-center">
                  {t('inventory.settings.to', { name: to.name })}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {locs.map((from) => (
              <TableRow key={from.id}>
                <TableCell className="font-medium">{from.name}</TableCell>
                {locs.map((to) => (
                  <TableCell key={to.id} className="text-center">
                    {from.id !== to.id && (
                      <Checkbox
                        aria-label={t('inventory.settings.needsReceiving', { from: from.name, to: to.name })}
                        checked={receiving.has(key(from.id, to.id))}
                        onCheckedChange={(on) =>
                          setReceiving((s) => {
                            const next = new Set(s);
                            if (on === true) next.add(key(from.id, to.id));
                            else next.delete(key(from.id, to.id));
                            return next;
                          })
                        }
                      />
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      <div>
        <Button onClick={() => void save()} disabled={typeof value !== 'number' || value < 0}>
          {t('inventory.settings.save')}
        </Button>
      </div>
    </>
  );
}
