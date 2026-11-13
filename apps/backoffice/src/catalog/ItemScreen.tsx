import type { CatalogLookups, ItemDetail } from '@erp/contracts';
import { PRICE_REASONS, priceChange } from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  formatMoney,
  Input,
  Label,
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
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { catalogRefusal, moneyText, moneyValue, NONE, qtyText, qtyValue, useLookups } from './data';
import { statusTone } from './ItemsScreen';

// One item (W1-15): details (CAT-01), codes and vehicles (CAT-02, CAT-03), prices and floor (CAT-04, CAT-05) and the
// price history (CAT-07). Each part saves on its own with the row version it read; prices only with cat.price.edit
// (the owner, owner answer 3), costs only with cost.view.

type Message = { text: string; error: boolean } | null;

export function ItemScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const { lookups, reload: reloadLookups } = useLookups(api);
  const [detail, setDetail] = useState<ItemDetail | null | undefined>(undefined);
  const [message, setMessage] = useState<Message>(null);

  const fetchDetail = useCallback(async () => {
    const r = await api('GET', `/api/catalog/items/${encodeURIComponent(id)}`);
    return r.status === 200 ? (r.body as ItemDetail) : null;
  }, [api, id]);
  useEffect(() => {
    let live = true;
    void fetchDetail().then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [fetchDetail]);
  const reload = async () => setDetail(await fetchDetail());

  const back = (
    <a
      href={href.items}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('catalog.item.back')}
    </a>
  );
  if (detail === undefined || lookups === null)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (detail === null) return <PageHeader eyebrow={back} title={t('catalog.item.notFound')} />;

  /** Sends one part; a refusal is shown, a success reloads the item. */
  const save = async (method: 'PATCH' | 'PUT', path: string, body: unknown, done: string) => {
    const r = await api(method, `/api/catalog/items/${encodeURIComponent(id)}${path}`, body);
    if (r.status === 200 || r.status === 201) {
      setMessage({ text: done, error: false });
      await reload();
      return true;
    }
    setMessage({ text: catalogRefusal(t, (k) => t(k) !== k, r.body), error: true });
    return false;
  };

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono">{detail.item.code}</span>
            <span>{detail.item.name}</span>
          </span>
        }
        help={
          <span className="flex flex-wrap items-center gap-2">
            <StatusChip tone={statusTone[detail.item.status] ?? 'neutral'}>
              {t(`catalog.status.${detail.item.status}`)}
            </StatusChip>
            {/* Every movement of this item (W1-18, INV-07). */}
            <a
              href={href.stockCard(detail.item.id)}
              className="font-medium underline-offset-4 hover:underline"
            >
              {t('catalog.item.stockCard')}
            </a>
            {detail.item.updatedBy && (
              <span>
                {t('catalog.item.updated', {
                  by: detail.item.updatedBy,
                  at: new Date(detail.item.updatedAt).toLocaleString(lookups.money.locale),
                })}
              </span>
            )}
          </span>
        }
      />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <DetailsPart
        key={`d${detail.item.rowVersion}`}
        detail={detail}
        lookups={lookups}
        api={api}
        onAdded={reloadLookups}
        save={(body) => save('PATCH', '', body, t('catalog.item.savedDetails'))}
      />
      <CodesPart
        key={`c${detail.item.rowVersion}`}
        detail={detail}
        lookups={lookups}
        api={api}
        onAdded={reloadLookups}
        saveCodes={(body) => save('PUT', '/identifiers', body, t('catalog.item.savedCodes'))}
        saveVehicles={(body) => save('PUT', '/vehicles', body, t('catalog.item.savedVehicles'))}
      />
      <PricesPart
        key={`p${detail.item.rowVersion}`}
        detail={detail}
        lookups={lookups}
        save={(body) => save('PUT', '/prices', body, t('catalog.item.savedPrices'))}
      />
      <HistoryPart detail={detail} lookups={lookups} />
    </>
  );
}

function Part({
  title,
  children,
  onSubmit,
}: {
  title: string;
  children: ReactNode;
  onSubmit?: (e: FormEvent) => void;
}) {
  const body = <div className="flex flex-col gap-3.5 p-3.5">{children}</div>;
  return (
    <Panel aria-label={title} role="region">
      <h2 className="m-0 px-3.5 pt-3 font-display text-lg font-semibold">{title}</h2>
      {onSubmit ? <form onSubmit={onSubmit}>{body}</form> : body}
    </Panel>
  );
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        className="h-11 rounded-md border border-input bg-surface-2 px-2 text-base"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </div>
  );
}

/** A brand, origin or vehicle make that isn't in the list yet, added by name. */
function AddName({
  api,
  kind,
  onAdded,
}: {
  api: Api;
  kind: 'brands' | 'origins' | 'makes';
  onAdded: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open)
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t(`catalog.add.${kind}`)}
      </Button>
    );
  return (
    <span className="flex items-center gap-1.5">
      <Input
        aria-label={t(`catalog.add.${kind}`)}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-8 w-40"
      />
      <Button
        type="button"
        size="sm"
        disabled={name.trim() === ''}
        onClick={() =>
          void api('POST', `/api/catalog/${kind}`, { name }).then((r) => {
            if (r.status === 200 || r.status === 201) {
              setOpen(false);
              setName('');
              onAdded((r.body as { id: string }).id);
            }
          })
        }
      >
        {t('catalog.add.save')}
      </Button>
    </span>
  );
}

function DetailsPart({
  detail,
  lookups,
  api,
  onAdded,
  save,
}: {
  detail: ItemDetail;
  lookups: CatalogLookups;
  api: Api;
  onAdded: () => Promise<void>;
  save: (body: unknown) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const i = detail.item;
  const [f, setF] = useState({
    name: i.name,
    categoryId: i.categoryId,
    unitId: i.unitId,
    brandId: i.brandId ?? NONE,
    originId: i.originId ?? NONE,
    variant: i.variant ?? '',
    spec: i.spec ?? '',
    binLocation: i.binLocation ?? '',
    defaultSupplierId: i.defaultSupplierId ?? NONE,
    minQty: qtyText(i.minQty),
    maxQty: qtyText(i.maxQty),
    excludeFromReorder: i.excludeFromReorder,
    status: i.status,
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const can = lookups.can.editItems;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const minQty = qtyValue(f.minQty);
    const maxQty = qtyValue(f.maxQty);
    if (minQty === undefined || maxQty === undefined) return setError(t('catalog.problems.qty_number'));
    setError(null);
    void save({
      rowVersion: i.rowVersion,
      name: f.name,
      categoryId: f.categoryId,
      unitId: f.unitId,
      brandId: f.brandId || null,
      originId: f.originId || null,
      variant: f.variant,
      spec: f.spec,
      binLocation: f.binLocation,
      defaultSupplierId: f.defaultSupplierId || null,
      minQty,
      maxQty,
      excludeFromReorder: f.excludeFromReorder,
      status: f.status,
    });
  };

  return (
    <Part title={t('catalog.item.details')} onSubmit={submit}>
      <fieldset disabled={!can} className="m-0 grid gap-3.5 border-0 p-0 md:grid-cols-3">
        <TextField
          label={t('catalog.fields.name')}
          value={f.name}
          onChange={(e) => set('name', e.target.value)}
          wrapperClassName="md:col-span-3"
        />
        <SelectField
          label={t('catalog.fields.category')}
          value={f.categoryId}
          onChange={(v) => set('categoryId', v)}
        >
          {lookups.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} · {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('catalog.fields.unit')} value={f.unitId} onChange={(v) => set('unitId', v)}>
          {lookups.units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.code}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('catalog.fields.status')}
          value={f.status}
          onChange={(v) => set('status', v as typeof f.status)}
        >
          {(['active', 'dormant', 'discontinued'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`catalog.status.${s}`)}
            </option>
          ))}
        </SelectField>
        <div className="flex flex-col gap-1">
          <SelectField
            label={t('catalog.fields.brand')}
            value={f.brandId}
            onChange={(v) => set('brandId', v)}
          >
            <option value={NONE}>—</option>
            {lookups.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
          {can && (
            <AddName
              api={api}
              kind="brands"
              onAdded={(nid) => void onAdded().then(() => set('brandId', nid))}
            />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <SelectField
            label={t('catalog.fields.origin')}
            value={f.originId}
            onChange={(v) => set('originId', v)}
          >
            <option value={NONE}>—</option>
            {lookups.origins.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </SelectField>
          {can && (
            <AddName
              api={api}
              kind="origins"
              onAdded={(nid) => void onAdded().then(() => set('originId', nid))}
            />
          )}
        </div>
        <SelectField
          label={t('catalog.fields.supplier')}
          value={f.defaultSupplierId}
          onChange={(v) => set('defaultSupplierId', v)}
        >
          <option value={NONE}>—</option>
          {lookups.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('catalog.fields.variant')}
          value={f.variant}
          onChange={(e) => set('variant', e.target.value)}
        />
        <TextField
          label={t('catalog.fields.spec')}
          value={f.spec}
          onChange={(e) => set('spec', e.target.value)}
        />
        <TextField
          label={t('catalog.fields.bin')}
          value={f.binLocation}
          onChange={(e) => set('binLocation', e.target.value)}
        />
        <TextField
          label={t('catalog.fields.minQty')}
          inputMode="decimal"
          value={f.minQty}
          onChange={(e) => set('minQty', e.target.value)}
        />
        <TextField
          label={t('catalog.fields.maxQty')}
          inputMode="decimal"
          value={f.maxQty}
          onChange={(e) => set('maxQty', e.target.value)}
        />
        <div className="flex items-center gap-2 self-end pb-2.5">
          <Checkbox
            id={`reorder-${i.id}`}
            checked={f.excludeFromReorder}
            onCheckedChange={(v) => set('excludeFromReorder', v === true)}
          />
          <Label htmlFor={`reorder-${i.id}`}>{t('catalog.fields.excludeFromReorder')}</Label>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      {can && (
        <div>
          <Button type="submit">{t('catalog.item.saveDetails')}</Button>
        </div>
      )}
    </Part>
  );
}

type IdRow = ItemDetail['identifiers'][number];
type VehicleRow = { makeId: string; model: string; yearFrom: string; yearTo: string; note: string };
const KINDS = ['barcode', 'oem', 'alternate', 'supplier_ref'] as const;

function CodesPart({
  detail,
  lookups,
  api,
  onAdded,
  saveCodes,
  saveVehicles,
}: {
  detail: ItemDetail;
  lookups: CatalogLookups;
  api: Api;
  onAdded: () => Promise<void>;
  saveCodes: (body: unknown) => Promise<boolean>;
  saveVehicles: (body: unknown) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const can = lookups.can.editItems;
  const [codes, setCodes] = useState<Pick<IdRow, 'kind' | 'value'>[]>(
    detail.identifiers.map(({ kind, value }) => ({ kind, value })),
  );
  const [vehicles, setVehicles] = useState<VehicleRow[]>(
    detail.vehicles.map((v) => ({
      makeId: v.makeId ?? NONE,
      model: v.model ?? '',
      yearFrom: v.yearFrom === null ? '' : String(v.yearFrom),
      yearTo: v.yearTo === null ? '' : String(v.yearTo),
      note: v.note ?? '',
    })),
  );
  const year = (s: string) => (s.trim() === '' ? null : Number(s));
  const own = (v: IdRow['value'], k: IdRow['kind']) =>
    k === 'barcode' && v.trim().toUpperCase() === detail.item.code;

  return (
    <Part title={t('catalog.item.codes')}>
      <div className="flex flex-col gap-2">
        <h3 className={LABEL_CLASS}>{t('catalog.item.identifiers')}</h3>
        {codes.map((c, n) => (
          <div key={n} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t('catalog.item.kind')}
              className="h-10 rounded-md border border-input bg-surface-2 px-2"
              value={c.kind}
              disabled={!can || own(c.value, c.kind)}
              onChange={(e) =>
                setCodes(codes.map((x, m) => (m === n ? { ...x, kind: e.target.value as IdRow['kind'] } : x)))
              }
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`catalog.kinds.${k}`)}
                </option>
              ))}
            </select>
            <Input
              aria-label={t('catalog.item.value')}
              className="h-10 w-64 font-mono"
              value={c.value}
              disabled={!can || own(c.value, c.kind)}
              onChange={(e) => setCodes(codes.map((x, m) => (m === n ? { ...x, value: e.target.value } : x)))}
            />
            {can && !own(c.value, c.kind) && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCodes(codes.filter((_, m) => m !== n))}
              >
                {t('catalog.item.remove')}
              </Button>
            )}
          </div>
        ))}
        {can && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setCodes([...codes, { kind: 'oem', value: '' }])}
            >
              {t('catalog.item.addCode')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveCodes({ rowVersion: detail.item.rowVersion, identifiers: codes })}
            >
              {t('catalog.item.saveCodes')}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={LABEL_CLASS}>{t('catalog.item.vehicles')}</h3>
        {vehicles.length === 0 && (
          <p className="m-0 text-sm text-muted-foreground">{t('catalog.item.noVehicles')}</p>
        )}
        {vehicles.map((v, n) => {
          const put = (patch: Partial<VehicleRow>) =>
            setVehicles(vehicles.map((x, m) => (m === n ? { ...x, ...patch } : x)));
          return (
            <div key={n} className="flex flex-wrap items-center gap-2">
              <select
                aria-label={t('catalog.fields.make')}
                className="h-10 rounded-md border border-input bg-surface-2 px-2"
                value={v.makeId}
                disabled={!can}
                onChange={(e) => put({ makeId: e.target.value })}
              >
                <option value={NONE}>—</option>
                {lookups.makes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <Input
                aria-label={t('catalog.fields.model')}
                className="h-10 w-40"
                value={v.model}
                disabled={!can}
                onChange={(e) => put({ model: e.target.value })}
              />
              <Input
                aria-label={t('catalog.fields.yearFrom')}
                className="h-10 w-24"
                inputMode="numeric"
                value={v.yearFrom}
                disabled={!can}
                onChange={(e) => put({ yearFrom: e.target.value })}
              />
              <Input
                aria-label={t('catalog.fields.yearTo')}
                className="h-10 w-24"
                inputMode="numeric"
                value={v.yearTo}
                disabled={!can}
                onChange={(e) => put({ yearTo: e.target.value })}
              />
              <Input
                aria-label={t('catalog.fields.note')}
                className="h-10 w-48"
                value={v.note}
                disabled={!can}
                onChange={(e) => put({ note: e.target.value })}
              />
              {can && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setVehicles(vehicles.filter((_, m) => m !== n))}
                >
                  {t('catalog.item.remove')}
                </Button>
              )}
            </div>
          );
        })}
        {can && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setVehicles([...vehicles, { makeId: NONE, model: '', yearFrom: '', yearTo: '', note: '' }])
              }
            >
              {t('catalog.item.addVehicle')}
            </Button>
            <AddName api={api} kind="makes" onAdded={() => void onAdded()} />
            <Button
              type="button"
              size="sm"
              onClick={() =>
                void saveVehicles({
                  rowVersion: detail.item.rowVersion,
                  vehicles: vehicles.map((v) => ({
                    makeId: v.makeId || null,
                    model: v.model,
                    yearFrom: year(v.yearFrom),
                    yearTo: year(v.yearTo),
                    note: v.note,
                  })),
                })
              }
            >
              {t('catalog.item.saveVehicles')}
            </Button>
          </div>
        )}
      </div>
    </Part>
  );
}

function PricesPart({
  detail,
  lookups,
  save,
}: {
  detail: ItemDetail;
  lookups: CatalogLookups;
  save: (body: unknown) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const m = lookups.money;
  const can = lookups.can.editPrices;
  const [tiers, setTiers] = useState<Record<string, string>>(
    Object.fromEntries(
      lookups.tiers.map((x) => [x.code, moneyText(detail.prices[x.code] ?? null, m.minorUnits)]),
    ),
  );
  const [floor, setFloor] = useState(moneyText(detail.floor.own, m.minorUnits));
  const [reason, setReason] = useState<string>(NONE);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();

  const values = Object.fromEntries(
    lookups.tiers.map((x) => [x.code, moneyValue(tiers[x.code] ?? '', m.minorUnits)]),
  );
  const floorValue = moneyValue(floor, m.minorUnits);
  const bad = Object.values(values).some((v) => v === undefined) || floorValue === undefined;
  // The same check as the server's, so the reason is asked for as soon as a price goes down (owner answer 2).
  const check = bad
    ? null
    : priceChange({
        before: { tiers: detail.prices, floor: detail.floor.own },
        after: { tiers: values as Record<string, number | null>, floor: floorValue ?? null },
        reason: reason || null,
        note,
      });
  const goesDown = check?.changes.some((c) => c.old !== null && c.new !== null && c.new < c.old) ?? false;
  const show = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, m));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (bad) return setError(t('catalog.problems.price_number'));
    setError(null);
    void save({
      rowVersion: detail.item.rowVersion,
      tiers: values,
      floor: floorValue ?? null,
      reason: reason || null,
      note: note.trim() || null,
    });
  };

  return (
    <Part title={t('catalog.item.prices')} onSubmit={submit}>
      {!can && <p className="m-0 text-sm text-muted-foreground">{t('catalog.item.pricesOwnerOnly')}</p>}
      <fieldset disabled={!can} className="m-0 grid gap-3.5 border-0 p-0 md:grid-cols-4">
        {lookups.tiers.map((x) => (
          <TextField
            key={x.code}
            label={x.name}
            inputMode="decimal"
            value={tiers[x.code] ?? ''}
            onChange={(e) => setTiers({ ...tiers, [x.code]: e.target.value })}
          />
        ))}
        <TextField
          label={t('catalog.item.ownFloor')}
          hint={t('catalog.item.ownFloorHint')}
          inputMode="decimal"
          value={floor}
          onChange={(e) => setFloor(e.target.value)}
        />
      </fieldset>
      <p className="m-0 text-sm" role="status">
        {t(`catalog.item.floorFrom.${detail.floor.source}`, {
          floor: show(detail.floor.effective),
          fromCost: show(detail.floor.fromCost),
        })}
      </p>
      {check?.warnings.includes('floor_above_retail') && (
        <p className="m-0 text-sm text-warn">{t('catalog.problems.floor_above_retail')}</p>
      )}
      {can && goesDown && (
        <div className="grid gap-3.5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={reasonId} className={LABEL_CLASS}>
              {t('catalog.item.reason')}
            </label>
            <select
              id={reasonId}
              className="h-11 rounded-md border border-input bg-surface-2 px-2"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value={NONE}>—</option>
              {PRICE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`catalog.reasons.${r}`)}
                </option>
              ))}
            </select>
          </div>
          <TextField label={t('catalog.item.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
      {detail.cost && (
        <dl className="m-0 grid gap-1 text-sm md:grid-cols-4">
          <div>
            <dt className={LABEL_CLASS}>{t('catalog.cost.average')}</dt>
            <dd className="m-0 tabular-nums">{show(detail.cost.avgCost)}</dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>{t('catalog.cost.last')}</dt>
            <dd className="m-0 tabular-nums">{show(detail.cost.lastCost)}</dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>{t('catalog.cost.supplier')}</dt>
            <dd className="m-0">{detail.cost.lastSupplier ?? '—'}</dd>
          </div>
          <div>
            <dt className={LABEL_CLASS}>{t('catalog.cost.date')}</dt>
            <dd className="m-0">
              {detail.cost.lastReceiptAt
                ? new Date(detail.cost.lastReceiptAt).toLocaleDateString(m.locale)
                : '—'}
            </dd>
          </div>
        </dl>
      )}
      {can && (
        <div>
          <Button type="submit">{t('catalog.item.savePrices')}</Button>
        </div>
      )}
    </Part>
  );
}

function HistoryPart({ detail, lookups }: { detail: ItemDetail; lookups: CatalogLookups }) {
  const { t } = useTranslation();
  const m = lookups.money;
  const tierName = new Map(lookups.tiers.map((x) => [x.code, x.name]));
  const show = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, m));
  return (
    <Part title={t('catalog.item.history')}>
      {detail.history.length === 0 ? (
        <p className="m-0 text-muted-foreground">{t('catalog.item.noHistory')}</p>
      ) : (
        <Table aria-label={t('catalog.item.history')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('catalog.history.at')}</TableHead>
              <TableHead>{t('catalog.history.price')}</TableHead>
              <TableHead className="text-end">{t('catalog.history.old')}</TableHead>
              <TableHead className="text-end">{t('catalog.history.new')}</TableHead>
              <TableHead>{t('catalog.history.why')}</TableHead>
              <TableHead>{t('catalog.history.by')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.history.map((h, n) => (
              <TableRow key={n}>
                <TableCell>{new Date(h.at).toLocaleString(m.locale)}</TableCell>
                <TableCell>
                  {h.target === 'floor' ? t('catalog.item.ownFloor') : (tierName.get(h.target) ?? h.target)}
                </TableCell>
                <TableCell className="text-end tabular-nums">{show(h.old)}</TableCell>
                <TableCell className="text-end tabular-nums">{show(h.new)}</TableCell>
                <TableCell>
                  {[h.reason ? t(`catalog.reasons.${h.reason}`) : null, h.note].filter(Boolean).join(' · ') ||
                    '—'}
                </TableCell>
                <TableCell>{h.by ?? t(`catalog.history.sources.${h.source}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Part>
  );
}
