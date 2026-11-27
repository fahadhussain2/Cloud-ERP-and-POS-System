import type { CatalogLookups, ItemDetail } from '@erp/contracts';
import { PRICE_REASONS, priceChange } from '@erp/domain';
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
import { Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import {
  Button,
  Checkbox,
  FIELD_LABEL,
  IconButton,
  ListPicker,
  notify,
  Select,
  TextBox,
  TextInput,
  type SelectOption,
} from '../ui';
import { catalogRefusal, moneyText, moneyValue, NONE, qtyText, qtyValue, useLookups } from './data';
import { statusTone } from './ItemsScreen';

// One item (W1-15): details (CAT-01), codes and vehicles (CAT-02, CAT-03), prices and floor (CAT-04, CAT-05) and the
// price history (CAT-07). Each part saves on its own with the row version it read; prices only with cat.price.edit
// (the owner, owner answer 3), costs only with cost.view. W2-14 (D-127): the back office's own controls; lists that
// keep growing (category, brand, supplier, vehicle make) are searched (owner answer 3); problems show at their field
// and results and refusals in a toast (owner answer 6).

export function ItemScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const { lookups, reload: reloadLookups } = useLookups(api);
  const [detail, setDetail] = useState<ItemDetail | null | undefined>(undefined);

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

  /** Sends one part; a refusal is a toast, a success says so and reloads the item. */
  const save = async (method: 'PATCH' | 'PUT', path: string, body: unknown, done: string) => {
    const r = await api(method, `/api/catalog/items/${encodeURIComponent(id)}${path}`, body);
    if (r.status === 200 || r.status === 201) {
      notify.done(done);
      await reload();
      return true;
    }
    notify.problem(catalogRefusal(t, (k) => t(k) !== k, r.body));
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
      {onSubmit ? (
        <form onSubmit={onSubmit} noValidate>
          {body}
        </form>
      ) : (
        body
      )}
    </Panel>
  );
}

/** "None", as an option of an optional choice (a dropdown's option can't be empty). */
const NONE_OPTION = 'none';

/** A short optional list (origin) as the kit's dropdown, with "—" for none. */
function OptionalSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
}) {
  return (
    <Select
      label={label}
      value={value || NONE_OPTION}
      onValueChange={(v) => onChange(v === NONE_OPTION ? NONE : v)}
      options={[{ value: NONE_OPTION, label: '—' }, ...options]}
    />
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
      <Button
        type="button"
        size="sm"
        variant="ghost"
        icon={Plus}
        className="self-start"
        onClick={() => setOpen(true)}
      >
        {t(`catalog.add.${kind}`)}
      </Button>
    );
  return (
    <span className="flex items-center gap-1.5">
      <TextBox
        aria-label={t(`catalog.add.${kind}`)}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-8 w-40"
      />
      <Button
        type="button"
        size="sm"
        icon={Save}
        disabled={name.trim() === ''}
        onClick={() =>
          void api('POST', `/api/catalog/${kind}`, { name }).then((r) => {
            if (r.status === 200 || r.status === 201) {
              setOpen(false);
              setName('');
              onAdded((r.body as { id: string }).id);
            } else notify.problem(catalogRefusal(t, (k) => t(k) !== k, r.body));
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
  const [problems, setProblems] = useState<{
    minQty?: string;
    maxQty?: string;
    categoryId?: string;
  }>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setProblems((p) => (k in p ? { ...p, [k]: undefined } : p));
  };
  const can = lookups.can.editItems;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const minQty = qtyValue(f.minQty);
    const maxQty = qtyValue(f.maxQty);
    const wrong: typeof problems = {};
    if (minQty === undefined) wrong.minQty = t('catalog.problems.qty_number');
    if (maxQty === undefined) wrong.maxQty = t('catalog.problems.qty_number');
    if (!f.categoryId) wrong.categoryId = t('catalog.problems.category_required');
    setProblems(wrong);
    if (Object.keys(wrong).length > 0 || minQty === undefined || maxQty === undefined) {
      // Focus on the first field marked wrong (owner answer 6).
      setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
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
      <fieldset disabled={!can} className="m-0 grid grid-cols-1 gap-3.5 border-0 p-0 md:grid-cols-3">
        <TextInput
          label={t('catalog.fields.name')}
          value={f.name}
          onChange={(e) => set('name', e.target.value)}
          wrapperClassName="md:col-span-3"
        />
        <ListPicker
          label={t('catalog.fields.category')}
          options={lookups.categories}
          value={f.categoryId}
          error={problems.categoryId}
          onChange={(v) => set('categoryId', v)}
        />
        <Select
          label={t('catalog.fields.unit')}
          value={f.unitId}
          onValueChange={(v) => set('unitId', v)}
          options={lookups.units.map((u) => ({ value: u.id, label: u.code }))}
        />
        <Select
          label={t('catalog.fields.status')}
          value={f.status}
          onValueChange={(v) => set('status', v as typeof f.status)}
          options={(['active', 'dormant', 'discontinued'] as const).map((s) => ({
            value: s,
            label: t(`catalog.status.${s}`),
          }))}
        />
        <div className="flex flex-col gap-1">
          <ListPicker
            label={t('catalog.fields.brand')}
            options={lookups.brands}
            value={f.brandId}
            onChange={(v) => set('brandId', v)}
          />
          {can && (
            <AddName
              api={api}
              kind="brands"
              onAdded={(nid) => void onAdded().then(() => set('brandId', nid))}
            />
          )}
        </div>
        <div className="flex flex-col gap-1">
          <OptionalSelect
            label={t('catalog.fields.origin')}
            value={f.originId}
            onChange={(v) => set('originId', v)}
            options={lookups.origins.map((o) => ({
              value: o.id,
              label: o.name,
            }))}
          />
          {can && (
            <AddName
              api={api}
              kind="origins"
              onAdded={(nid) => void onAdded().then(() => set('originId', nid))}
            />
          )}
        </div>
        <ListPicker
          label={t('catalog.fields.supplier')}
          options={lookups.suppliers}
          value={f.defaultSupplierId}
          onChange={(v) => set('defaultSupplierId', v)}
        />
        <TextInput
          label={t('catalog.fields.variant')}
          value={f.variant}
          onChange={(e) => set('variant', e.target.value)}
        />
        <TextInput
          label={t('catalog.fields.spec')}
          value={f.spec}
          onChange={(e) => set('spec', e.target.value)}
        />
        <TextInput
          label={t('catalog.fields.bin')}
          value={f.binLocation}
          onChange={(e) => set('binLocation', e.target.value)}
        />
        <TextInput
          label={t('catalog.fields.minQty')}
          error={problems.minQty}
          inputMode="decimal"
          value={f.minQty}
          onChange={(e) => set('minQty', e.target.value)}
        />
        <TextInput
          label={t('catalog.fields.maxQty')}
          error={problems.maxQty}
          inputMode="decimal"
          value={f.maxQty}
          onChange={(e) => set('maxQty', e.target.value)}
        />
        <Checkbox
          className="self-end pb-2.5"
          id={`reorder-${i.id}`}
          label={t('catalog.fields.excludeFromReorder')}
          checked={f.excludeFromReorder}
          onCheckedChange={(v) => set('excludeFromReorder', v)}
        />
      </fieldset>
      {can && (
        <div>
          <Button type="submit" icon={Save}>
            {t('catalog.item.saveDetails')}
          </Button>
        </div>
      )}
    </Part>
  );
}
type IdRow = ItemDetail['identifiers'][number];
type VehicleRow = {
  makeId: string;
  model: string;
  yearFrom: string;
  yearTo: string;
  note: string;
};
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
        <h3 className={`m-0 ${FIELD_LABEL}`}>{t('catalog.item.identifiers')}</h3>
        {codes.map((c, n) => (
          <div key={n} className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('catalog.item.kind')}
              wrapperClassName="w-40"
              value={c.kind}
              disabled={!can || own(c.value, c.kind)}
              onValueChange={(v) =>
                setCodes(codes.map((x, m) => (m === n ? { ...x, kind: v as IdRow['kind'] } : x)))
              }
              options={KINDS.map((k) => ({
                value: k,
                label: t(`catalog.kinds.${k}`),
              }))}
            />
            <TextBox
              aria-label={t('catalog.item.value')}
              className="w-64 font-mono"
              value={c.value}
              disabled={!can || own(c.value, c.kind)}
              onChange={(e) => setCodes(codes.map((x, m) => (m === n ? { ...x, value: e.target.value } : x)))}
            />
            {can && !own(c.value, c.kind) && (
              <IconButton
                icon={Trash2}
                tone="danger"
                label={`${t('catalog.item.remove')} ${c.value}`.trim()}
                onClick={() => setCodes(codes.filter((_, m) => m !== n))}
              />
            )}
          </div>
        ))}
        {can && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              icon={Plus}
              onClick={() => setCodes([...codes, { kind: 'oem', value: '' }])}
            >
              {t('catalog.item.addCode')}
            </Button>
            <Button
              type="button"
              size="sm"
              icon={Save}
              onClick={() =>
                void saveCodes({
                  rowVersion: detail.item.rowVersion,
                  identifiers: codes,
                })
              }
            >
              {t('catalog.item.saveCodes')}
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className={`m-0 ${FIELD_LABEL}`}>{t('catalog.item.vehicles')}</h3>
        {vehicles.length === 0 && (
          <p className="m-0 text-sm text-muted-foreground">{t('catalog.item.noVehicles')}</p>
        )}
        {vehicles.map((v, n) => {
          const put = (patch: Partial<VehicleRow>) =>
            setVehicles(vehicles.map((x, m) => (m === n ? { ...x, ...patch } : x)));
          return (
            <div key={n} className="flex flex-wrap items-center gap-2">
              <ListPicker
                hideLabel
                className="w-44"
                label={t('catalog.fields.make')}
                options={lookups.makes}
                value={v.makeId}
                disabled={!can}
                onChange={(id) => put({ makeId: id })}
              />
              <TextBox
                aria-label={t('catalog.fields.model')}
                className="w-40"
                value={v.model}
                disabled={!can}
                onChange={(e) => put({ model: e.target.value })}
              />
              <TextBox
                aria-label={t('catalog.fields.yearFrom')}
                className="w-24"
                inputMode="numeric"
                value={v.yearFrom}
                disabled={!can}
                onChange={(e) => put({ yearFrom: e.target.value })}
              />
              <TextBox
                aria-label={t('catalog.fields.yearTo')}
                className="w-24"
                inputMode="numeric"
                value={v.yearTo}
                disabled={!can}
                onChange={(e) => put({ yearTo: e.target.value })}
              />
              <TextBox
                aria-label={t('catalog.fields.note')}
                className="w-48"
                value={v.note}
                disabled={!can}
                onChange={(e) => put({ note: e.target.value })}
              />
              {can && (
                <IconButton
                  icon={Trash2}
                  tone="danger"
                  label={`${t('catalog.item.remove')} ${v.model}`.trim()}
                  onClick={() => setVehicles(vehicles.filter((_, m) => m !== n))}
                />
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
              icon={Plus}
              onClick={() =>
                setVehicles([
                  ...vehicles,
                  {
                    makeId: NONE,
                    model: '',
                    yearFrom: '',
                    yearTo: '',
                    note: '',
                  },
                ])
              }
            >
              {t('catalog.item.addVehicle')}
            </Button>
            <AddName api={api} kind="makes" onAdded={() => void onAdded()} />
            <Button
              type="button"
              size="sm"
              icon={Save}
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
  // After Save is tried, each price that isn't an amount is marked at its field (owner answer 6).
  const [tried, setTried] = useState(false);

  const values = Object.fromEntries(
    lookups.tiers.map((x) => [x.code, moneyValue(tiers[x.code] ?? '', m.minorUnits)]),
  );
  const floorValue = moneyValue(floor, m.minorUnits);
  const bad = Object.values(values).some((v) => v === undefined) || floorValue === undefined;
  const wrong = (v: number | null | undefined) =>
    tried && v === undefined ? t('catalog.problems.price_number') : undefined;
  // The same check as the server's, so the reason is asked for as soon as a price goes down (owner answer 2).
  const check = bad
    ? null
    : priceChange({
        before: { tiers: detail.prices, floor: detail.floor.own },
        after: {
          tiers: values as Record<string, number | null>,
          floor: floorValue ?? null,
        },
        reason: reason || null,
        note,
      });
  const goesDown = check?.changes.some((c) => c.old !== null && c.new !== null && c.new < c.old) ?? false;
  const show = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, m));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (bad) {
      setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
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
      <fieldset disabled={!can} className="m-0 grid grid-cols-1 gap-3.5 border-0 p-0 md:grid-cols-4">
        {lookups.tiers.map((x) => (
          <TextInput
            key={x.code}
            label={x.name}
            error={wrong(values[x.code])}
            inputMode="decimal"
            value={tiers[x.code] ?? ''}
            onChange={(e) => setTiers({ ...tiers, [x.code]: e.target.value })}
          />
        ))}
        <TextInput
          label={t('catalog.item.ownFloor')}
          hint={t('catalog.item.ownFloorHint')}
          error={wrong(floorValue)}
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
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Select
            label={t('catalog.item.reason')}
            placeholder="—"
            value={reason}
            onValueChange={setReason}
            options={PRICE_REASONS.map((r) => ({
              value: r,
              label: t(`catalog.reasons.${r}`),
            }))}
          />
          <TextInput label={t('catalog.item.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {detail.cost && (
        <dl className="m-0 grid grid-cols-1 gap-1 text-sm md:grid-cols-4">
          <div>
            <dt className={FIELD_LABEL}>{t('catalog.cost.average')}</dt>
            <dd className="m-0 tabular-nums">{show(detail.cost.avgCost)}</dd>
          </div>
          <div>
            <dt className={FIELD_LABEL}>{t('catalog.cost.last')}</dt>
            <dd className="m-0 tabular-nums">{show(detail.cost.lastCost)}</dd>
          </div>
          <div>
            <dt className={FIELD_LABEL}>{t('catalog.cost.supplier')}</dt>
            <dd className="m-0">{detail.cost.lastSupplier ?? '—'}</dd>
          </div>
          <div>
            <dt className={FIELD_LABEL}>{t('catalog.cost.date')}</dt>
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
          <Button type="submit" icon={Save}>
            {t('catalog.item.savePrices')}
          </Button>
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
        <div className="overflow-x-auto">
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
                    {[h.reason ? t(`catalog.reasons.${h.reason}`) : null, h.note]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </TableCell>
                  <TableCell>{h.by ?? t(`catalog.history.sources.${h.source}`)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Part>
  );
}
