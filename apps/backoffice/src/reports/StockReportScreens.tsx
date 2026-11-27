import {
  DEAD_DAYS,
  STOCK_GROUPS,
  type AnalysisRow,
  type AnalysisView,
  type DeadStockRow,
  type DeadStockView,
  type ReorderRow,
  type ReorderView,
  type StockAgeKindView,
  type StockAtView,
  type StockChoicesView,
  type StockGroup,
  type StockLedgerLine,
  type StockLedgerView,
  type StockLine,
  type StockMovementCells,
  type StockMovementView,
} from '@erp/contracts';
import { StatusChip } from '@erp/ui';

import { Checkbox, FIELD_LABEL } from '../ui';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { ItemPicker } from '../purchasing/ItemPicker';
import { href, queryOf, withQuery } from '../router';
import { apiQuery, useFilters, type Filters } from './frame/filters';
import { documentHref } from './frame/links';
import {
  ChoiceFilter,
  DateFilter,
  ListTable,
  moneyText,
  PeriodFilter,
  periodOf,
  periodQuery,
  periodWords,
  ReportPage,
  StatementTable,
  useReport,
  type ListColumn,
  type PeriodValue,
  type StatementLine,
} from './frame/ReportFrame';

// The stock reports (W2-02 plan; RPT-08, RPT-12, RPT-13, RPT-14, PUR-07 list; owner answers 1–8; D-116), each on the
// report frame. Read only; every one needs reports.view, and values come only with cost.view (the API leaves them out).
// Quantities are thousandths, shown as the stock screens show them.

const s = (t: TFunction, key: string, o?: Record<string, unknown>) =>
  t(`reports.stockReports.${key}`, o ?? {});

/** An item's stock ledger for a period: where every stock row opens (owner answer 6). */
export const stockLedgerHref = (itemId: string, period?: { from: string; to: string }) =>
  withQuery(href.stockLedger, { itemId, ...(period ? { from: period.from, to: period.to } : {}) });

/** The filters' choices (category, make, brand, location, supplier). */
function useChoices(api: Api) {
  return useReport<StockChoicesView>(api, '/api/reports/stock-choices').report;
}

type ChoiceKey = 'categoryId' | 'makeId' | 'brandId' | 'locationId' | 'supplierId';
const CHOICES: Record<ChoiceKey, keyof StockChoicesView> = {
  categoryId: 'categories',
  makeId: 'makes',
  brandId: 'brands',
  locationId: 'locations',
  supplierId: 'suppliers',
};

/** Dropdowns for the item filters: all, or one category, make, brand, location or supplier. */
function ItemFilters({
  choices,
  filters,
  keys,
  onChange,
}: {
  choices: StockChoicesView | null;
  filters: Filters;
  keys: ChoiceKey[];
  onChange: (key: ChoiceKey, v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {keys.map((k) => (
        <ChoiceFilter
          key={k}
          label={s(t, `filter.${k}`)}
          value={filters[k] ?? ''}
          options={[
            { value: '', label: s(t, 'all') },
            ...(choices?.[CHOICES[k]] ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
          onChange={(v) => onChange(k, v)}
        />
      ))}
    </>
  );
}

/** The chosen filters in words, for the printed header. */
function filterWords(t: TFunction, choices: StockChoicesView | null, filters: Filters, keys: ChoiceKey[]) {
  return keys
    .filter((k) => filters[k])
    .map((k) => {
      const c = choices?.[CHOICES[k]].find((x) => x.id === filters[k]);
      return `${s(t, `filter.${k}`)}: ${c?.name ?? ''}`;
    });
}

/**
 * The filters now: the address's, which a change before the screen caught up (two quick changes) already moved, else
 * the ones the screen was drawn with (restored ones are put into the address too).
 */
function current(filters: Filters): Filters {
  const q = queryOf(window.location.hash);
  return q.size > 0 ? Object.fromEntries(q) : filters;
}

/** Only the filters an API takes, without empty ones. */
const only = (f: Filters, keys: readonly string[]): Filters =>
  Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, f[k]!]));

/** A group's name: its own, or "No category", "No make"… for the items without one. */
function groupName(t: TFunction, group: StockGroup, depth: number, name: string) {
  if (name !== '') return name;
  const kind = group === 'category' ? (depth === 0 ? 'category' : 'make') : group;
  return s(t, `noGroup.${kind}`);
}

/** Stock lines as statement lines: groups with their count and subtotals, items opening their stock ledger. */
function stockLines<C>(
  t: TFunction,
  lines: StockLine<C>[],
  group: StockGroup,
  cells: (c: C) => (number | string | null)[],
  period?: { from: string; to: string },
): StatementLine[] {
  return lines.map((l): StatementLine =>
    l.kind === 'group'
      ? {
          key: `g:${l.path.join('\u0000')}`,
          kind: 'group',
          depth: l.depth,
          name: `${groupName(t, group, l.depth, l.name)} (${l.count})`,
          cells: cells(l.cells),
        }
      : {
          key: `r:${l.itemId}:${l.location ?? ''}`,
          kind: 'account',
          depth: l.depth,
          code: l.code,
          name: l.location ? `${l.name} · ${l.location}` : l.name,
          cells: cells(l.cells),
          href: stockLedgerHref(l.itemId, period),
        },
  );
}

const groupOptions = (t: TFunction) => STOCK_GROUPS.map((g) => ({ value: g, label: s(t, `group.${g}`) }));
const groupOf = (f: Filters): StockGroup => STOCK_GROUPS.find((g) => g === f['group']) ?? 'category';

function Truncated({ shown }: { shown: boolean }) {
  const { t } = useTranslation();
  return shown ? <p className="m-0 text-sm text-muted-foreground">{s(t, 'truncated')}</p> : null;
}

// ---- Stock at a date (RPT-13, owner answers 2 and 3) ----

const AT_KEYS: ChoiceKey[] = ['categoryId', 'makeId', 'brandId', 'locationId', 'supplierId'];

export function StockAtScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('stockAt');
  const choices = useChoices(api);
  const group = groupOf(filters);
  const negative = filters['negative'] === 'only';
  const query = only({ ...filters, group }, ['at', 'group', 'negative', ...AT_KEYS]);
  const url = `/api/reports/stock-at?${apiQuery(query)}`;
  const { report, error } = useReport<StockAtView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...current(filters), ...next }, ['at', 'group', 'negative', ...AT_KEYS]));
  const cells = (c: { qty: number; value: number | null }) => [
    qtyText(c.qty),
    ...(report?.values ? [c.value] : []),
  ];
  return (
    <ReportPage
      title={t('nav.stockAt')}
      help={s(t, 'at.help')}
      filters={
        <>
          <DateFilter
            label={s(t, 'at.date')}
            value={report?.at ?? filters['at'] ?? ''}
            onChange={(v) => set({ at: v })}
          />
          <ChoiceFilter
            label={s(t, 'groupBy')}
            value={group}
            options={groupOptions(t)}
            onChange={(v) => set({ group: v })}
          />
          <ItemFilters
            choices={choices}
            filters={filters}
            keys={AT_KEYS}
            onChange={(k, v) => set({ [k]: v })}
          />
          <Checkbox
            className="h-9 items-center"
            id="stock-negative"
            label={s(t, 'at.negative')}
            checked={negative}
            onCheckedChange={(c) => set({ negative: c ? 'only' : '' })}
          />
        </>
      }
      printFilters={[report?.at ?? '', ...filterWords(t, choices, filters, AT_KEYS)].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'items', label: s(t, 'items'), value: String(report.total.count) },
              { key: 'qty', label: s(t, 'qty'), value: qtyText(report.total.qty) },
              ...(report.values
                ? [{ key: 'value', label: s(t, 'value'), value: moneyText(report.total.value, m) }]
                : []),
            ]
          : []
      }
    >
      {report && m && (
        <>
          <Truncated shown={report.truncated} />
          <StatementTable
            label={t('nav.stockAt')}
            first={s(t, 'item')}
            money={m}
            columns={[s(t, 'qty'), ...(report.values ? [s(t, 'value')] : [])]}
            lines={[
              ...stockLines(t, report.lines, report.group, cells, { from: report.at, to: report.at }),
              { key: 'total', kind: 'total', depth: 0, name: s(t, 'total'), cells: cells(report.total) },
            ]}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Stock movement (RPT-13) ----

const MOVE_KEYS: ChoiceKey[] = ['categoryId', 'makeId', 'brandId', 'locationId', 'supplierId'];
const COLUMNS: (keyof StockMovementCells)[] = [
  'opening',
  'openings',
  'purchases',
  'purchaseReturns',
  'sales',
  'salesReturns',
  'adjustments',
  'transfersIn',
  'transfersOut',
  'closing',
];

export function StockMovementScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('stockMovement');
  const choices = useChoices(api);
  const period = periodOf(filters, 'thisMonth');
  const group = groupOf(filters);
  const measure = filters['show'] === 'value' ? 'value' : 'qty';
  const keep = ['preset', 'from', 'to', 'group', 'show', ...MOVE_KEYS];
  const url = `/api/reports/stock-movement?${apiQuery(only({ ...filters, ...periodQuery(period), group }, ['preset', 'from', 'to', 'group', ...MOVE_KEYS]))}`;
  const { report, error } = useReport<StockMovementView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, keep));
  const setPeriod = (p: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, keep));
  const byValue = measure === 'value' && report?.values === true;
  // Transfers show per location; over all locations they cancel out (the plan's design), unless they don't.
  const perLocation = report !== null && (report.group === 'location' || report.locationId !== null);
  const shown = COLUMNS.filter((c) => {
    if (!report) return true;
    const x = report.total[c];
    if (c === 'openings') return x.qty !== 0;
    if (c === 'transfersIn' || c === 'transfersOut')
      return perLocation || report.total.transfersIn.qty + report.total.transfersOut.qty !== 0;
    return true;
  });
  const cells = (c: StockMovementCells) => shown.map((k) => (byValue ? c[k].value : qtyText(c[k].qty)));
  return (
    <ReportPage
      title={t('nav.stockMovement')}
      help={s(t, 'movement.help')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <ChoiceFilter
            label={s(t, 'groupBy')}
            value={group}
            options={groupOptions(t)}
            onChange={(v) => set({ group: v })}
          />
          <ItemFilters
            choices={choices}
            filters={filters}
            keys={MOVE_KEYS}
            onChange={(k, v) => set({ [k]: v })}
          />
          {report?.values && (
            <ChoiceFilter
              label={s(t, 'movement.show')}
              value={measure}
              options={[
                { value: 'qty', label: s(t, 'qty') },
                { value: 'value', label: s(t, 'value') },
              ]}
              onChange={(v) => set({ show: v })}
            />
          )}
        </>
      }
      printFilters={[periodWords(report), ...filterWords(t, choices, filters, MOVE_KEYS)].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'items', label: s(t, 'items'), value: String(report.total.count) },
              {
                key: 'opening',
                label: s(t, 'movement.cols.opening'),
                value: byValue ? moneyText(report.total.opening.value, m) : qtyText(report.total.opening.qty),
              },
              {
                key: 'closing',
                label: s(t, 'movement.cols.closing'),
                value: byValue ? moneyText(report.total.closing.value, m) : qtyText(report.total.closing.qty),
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <Truncated shown={report.truncated} />
          <StatementTable
            label={t('nav.stockMovement')}
            first={s(t, 'item')}
            money={m}
            blankZero={byValue}
            columns={shown.map((c) => s(t, `movement.cols.${c}`))}
            lines={[
              ...stockLines(t, report.lines, report.group, cells, report),
              { key: 'total', kind: 'total', depth: 0, name: s(t, 'total'), cells: cells(report.total) },
            ]}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Stock ledger (RPT-12, owner answer 6) ----

export function StockLedgerScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('stockLedger');
  const choices = useChoices(api);
  const period = periodOf(filters, 'thisMonth');
  const itemId = filters['itemId'] ?? null;
  const keep = ['itemId', 'preset', 'from', 'to', 'locationId'];
  const url = itemId
    ? `/api/reports/stock-ledger?${apiQuery(only({ ...filters, ...periodQuery(period) }, keep))}`
    : null;
  const { report, error } = useReport<StockLedgerView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, keep));
  const setPeriod = (p: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, keep));
  const values = report?.values === true;
  const columns: ListColumn<StockLedgerLine>[] = [
    {
      key: 'date',
      label: s(t, 'ledger.date'),
      sort: (l) => `${l.date}:${String(l.seq).padStart(12, '0')}`,
      cell: (l) => l.date,
    },
    {
      key: 'document',
      label: t('reports.frame.document'),
      sort: (l) => l.number ?? '',
      cell: (l) => {
        const to = documentHref(l.kind, l.documentId, l.number);
        return to ? <a href={to}>{l.number}</a> : l.number;
      },
    },
    {
      key: 'kind',
      label: s(t, 'ledger.kind'),
      sort: (l) => l.kind,
      // D-124: value with no quantity is a cost correction, for stock sold before it arrived.
      cell: (l) => (l.qty === 0 ? s(t, 'kinds.costCorrection') : s(t, `kinds.${l.kind}`)),
    },
    { key: 'location', label: s(t, 'location'), sort: (l) => l.locationCode, cell: (l) => l.locationCode },
    { key: 'in', label: s(t, 'ledger.in'), end: true, cell: (l) => (l.qty > 0 ? qtyText(l.qty) : '') },
    { key: 'out', label: s(t, 'ledger.out'), end: true, cell: (l) => (l.qty < 0 ? qtyText(-l.qty) : '') },
    { key: 'balance', label: s(t, 'ledger.balance'), end: true, cell: (l) => qtyText(l.balance) },
    ...(values && m
      ? [
          {
            key: 'value',
            label: s(t, 'value'),
            end: true,
            cell: (l: StockLedgerLine) => moneyText(l.value, m),
          },
          {
            key: 'balanceValue',
            label: s(t, 'ledger.balanceValue'),
            end: true,
            cell: (l: StockLedgerLine) => moneyText(l.balanceValue, m),
          },
        ]
      : []),
  ];
  return (
    <ReportPage
      title={report ? `${report.item.code} ${report.item.name}` : t('nav.stockLedger')}
      eyebrow={report ? t('nav.stockLedger') : undefined}
      help={s(t, 'ledger.help')}
      filters={
        <>
          <div className="flex w-96 max-w-full flex-col gap-1">
            <span className={FIELD_LABEL}>{s(t, 'item')}</span>
            <ItemPicker
              api={api}
              url="/api/reports/items"
              label={s(t, 'item')}
              picked={report ? report.item : null}
              onPick={(item) => set({ itemId: item.id })}
            />
          </div>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <ItemFilters
            choices={choices}
            filters={filters}
            keys={['locationId']}
            onChange={(k, v) => set({ [k]: v })}
          />
        </>
      }
      printFilters={[periodWords(report), ...filterWords(t, choices, filters, ['locationId'])].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={itemId !== null && report === null}
      figures={
        report && m
          ? [
              { key: 'opening', label: s(t, 'ledger.opening'), value: qtyText(report.opening.qty) },
              { key: 'in', label: s(t, 'ledger.in'), value: qtyText(report.in.qty) },
              { key: 'out', label: s(t, 'ledger.out'), value: qtyText(-report.out.qty) },
              { key: 'closing', label: s(t, 'ledger.closing'), value: qtyText(report.closing.qty) },
              ...(values
                ? [
                    {
                      key: 'value',
                      label: s(t, 'ledger.closingValue'),
                      value: moneyText(report.closing.value, m),
                    },
                  ]
                : []),
            ]
          : []
      }
    >
      {itemId === null && <p className="text-muted-foreground">{s(t, 'ledger.pick')}</p>}
      {report && m && (
        <>
          <Truncated shown={report.truncated} />
          <ListTable
            label={s(t, 'ledger.lines')}
            columns={columns}
            rows={report.lines}
            rowKey={(l) => `${l.seq}:${l.locationCode}:${l.qty}:${l.balance}`}
            text={(l) => `${l.number ?? ''} ${s(t, `kinds.${l.kind}`)} ${l.locationCode}`}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- The reorder list (PUR-07 list, owner answer 4) ----

const REORDER_KEYS: ChoiceKey[] = ['supplierId', 'categoryId', 'makeId', 'brandId'];

export function ReorderScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('reorder');
  const choices = useChoices(api);
  const url = `/api/reports/reorder?${apiQuery(only(filters, REORDER_KEYS))}`;
  const { report, error } = useReport<ReorderView>(api, url);
  const m = report?.money;
  const set = (next: Filters) => setFilters(only({ ...current(filters), ...next }, REORDER_KEYS));
  const values = report?.values === true;
  const columns: ListColumn<ReorderRow>[] = [
    {
      key: 'supplier',
      label: s(t, 'filter.supplierId'),
      sort: (r) => r.supplier ?? '￿',
      cell: (r) => r.supplier ?? s(t, 'noGroup.supplier'),
    },
    {
      key: 'code',
      label: s(t, 'code'),
      sort: (r) => r.code,
      cell: (r) => <a href={stockLedgerHref(r.itemId)}>{r.code}</a>,
    },
    {
      key: 'name',
      label: s(t, 'name'),
      sort: (r) => r.name,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          {r.name}
          {r.levelsNeedFixing && <StatusChip tone="warn">{s(t, 'reorder.fixLevels')}</StatusChip>}
        </span>
      ),
    },
    {
      key: 'onHand',
      label: s(t, 'reorder.onHand'),
      end: true,
      sort: (r) => r.onHand,
      cell: (r) => qtyText(r.onHand),
    },
    { key: 'min', label: s(t, 'reorder.min'), end: true, cell: (r) => qtyText(r.min) },
    { key: 'max', label: s(t, 'reorder.max'), end: true, cell: (r) => qtyText(r.max) },
    {
      key: 'order',
      label: s(t, 'reorder.order'),
      end: true,
      sort: (r) => r.order,
      cell: (r) => <strong>{qtyText(r.order)}</strong>,
    },
    ...(values && m
      ? [
          {
            key: 'lastCost',
            label: s(t, 'reorder.lastCost'),
            end: true,
            cell: (r: ReorderRow) => moneyText(r.lastCost, m),
          },
          {
            key: 'orderValue',
            label: s(t, 'reorder.orderValue'),
            end: true,
            sort: (r: ReorderRow) => r.orderValue ?? 0,
            cell: (r: ReorderRow) => moneyText(r.orderValue, m),
          },
        ]
      : []),
    {
      key: 'lastReceipt',
      label: s(t, 'lastReceipt'),
      sort: (r) => r.lastReceipt ?? '',
      cell: (r) => r.lastReceipt ?? '—',
    },
    {
      key: 'sold30',
      label: s(t, 'reorder.sold30'),
      end: true,
      sort: (r) => r.sold30,
      cell: (r) => qtyText(r.sold30),
    },
    {
      key: 'sold90',
      label: s(t, 'reorder.sold90'),
      end: true,
      sort: (r) => r.sold90,
      cell: (r) => qtyText(r.sold90),
    },
    {
      key: 'cover',
      label: s(t, 'daysOfCover'),
      end: true,
      sort: (r) => r.daysOfCover ?? -1,
      cell: (r) => r.daysOfCover ?? '—',
    },
  ];
  return (
    <ReportPage
      title={t('nav.reorder')}
      help={s(t, 'reorder.help')}
      eyebrow={report ? s(t, 'since', { date: report.since }) : undefined}
      filters={
        <ItemFilters
          choices={choices}
          filters={filters}
          keys={REORDER_KEYS}
          onChange={(k, v) => set({ [k]: v })}
        />
      }
      printFilters={[report?.today ?? '', ...filterWords(t, choices, filters, REORDER_KEYS)].join(' · ')}
      csv={report && `${url}${url.endsWith('?') ? '' : '&'}format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'items', label: s(t, 'reorder.items'), value: String(report.total.count) },
              { key: 'suppliers', label: s(t, 'reorder.suppliers'), value: String(report.suppliers.length) },
              ...(values
                ? [
                    {
                      key: 'value',
                      label: s(t, 'reorder.orderValue'),
                      value: moneyText(report.total.value, m),
                    },
                  ]
                : []),
            ]
          : []
      }
    >
      {report && m && (
        <>
          <Truncated shown={report.truncated} />
          <ListTable
            label={t('nav.reorder')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.itemId}
            text={(r) => `${r.code} ${r.name} ${r.supplier ?? ''} ${r.category ?? ''}`}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Dead and slow stock (RPT-08, owner answers 1 and 5) ----

const DEAD_KEYS: ChoiceKey[] = ['categoryId', 'makeId', 'brandId', 'supplierId'];
const KINDS: StockAgeKindView[] = ['dead', 'notSoldSinceGoLive', 'slow'];

export function DeadStockScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('deadStock');
  const choices = useChoices(api);
  const days = DEAD_DAYS.find((d) => String(d) === filters['days']) ?? 90;
  const kind = KINDS.find((k) => k === filters['kind']) ?? null;
  const url = `/api/reports/dead-stock?${apiQuery({ ...only(filters, DEAD_KEYS), days: String(days) })}`;
  const { report, error } = useReport<DeadStockView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ days: String(days), ...current(filters), ...next }, ['days', 'kind', ...DEAD_KEYS]));
  const values = report?.values === true;
  const tone = (k: StockAgeKindView) => (k === 'dead' ? 'bad' : k === 'slow' ? 'warn' : 'neutral');
  const columns: ListColumn<DeadStockRow>[] = [
    {
      key: 'kind',
      label: s(t, 'dead.kind'),
      sort: (r) => KINDS.indexOf(r.kind),
      cell: (r) => <StatusChip tone={tone(r.kind)}>{s(t, `dead.kinds.${r.kind}`)}</StatusChip>,
    },
    {
      key: 'code',
      label: s(t, 'code'),
      sort: (r) => r.code,
      cell: (r) => <a href={stockLedgerHref(r.itemId)}>{r.code}</a>,
    },
    { key: 'name', label: s(t, 'name'), sort: (r) => r.name, cell: (r) => r.name },
    {
      key: 'category',
      label: s(t, 'filter.categoryId'),
      sort: (r) => r.category ?? '',
      cell: (r) => r.category ?? '',
    },
    {
      key: 'onHand',
      label: s(t, 'reorder.onHand'),
      end: true,
      sort: (r) => r.onHand,
      cell: (r) => qtyText(r.onHand),
    },
    ...(values && m
      ? [
          {
            key: 'value',
            label: s(t, 'value'),
            end: true,
            sort: (r: DeadStockRow) => r.value ?? 0,
            cell: (r: DeadStockRow) => moneyText(r.value, m),
          },
        ]
      : []),
    {
      key: 'lastSale',
      label: s(t, 'dead.lastSale'),
      sort: (r) => r.lastSale ?? '',
      cell: (r) => r.lastSale ?? s(t, 'dead.never'),
    },
    {
      key: 'lastReceipt',
      label: s(t, 'lastReceipt'),
      sort: (r) => r.lastReceipt ?? '',
      cell: (r) => r.lastReceipt ?? '—',
    },
    {
      key: 'sold90',
      label: s(t, 'reorder.sold90'),
      end: true,
      sort: (r) => r.sold90,
      cell: (r) => qtyText(r.sold90),
    },
    {
      key: 'cover',
      label: s(t, 'daysOfCover'),
      end: true,
      sort: (r) => r.daysOfCover ?? -1,
      cell: (r) => r.daysOfCover ?? '—',
    },
  ];
  const rows = report ? report.rows.filter((r) => kind === null || r.kind === kind) : [];
  return (
    <ReportPage
      title={t('nav.deadStock')}
      help={s(t, 'dead.help')}
      eyebrow={report ? s(t, 'since', { date: report.since }) : undefined}
      filters={
        <>
          <ChoiceFilter
            label={s(t, 'dead.days')}
            value={String(days)}
            options={DEAD_DAYS.map((d) => ({ value: String(d), label: s(t, 'dead.daysN', { count: d }) }))}
            onChange={(v) => set({ days: v })}
          />
          <ChoiceFilter
            label={s(t, 'dead.kind')}
            value={kind ?? ''}
            options={[
              { value: '', label: s(t, 'all') },
              ...KINDS.map((k) => ({ value: k, label: s(t, `dead.kinds.${k}`) })),
            ]}
            onChange={(v) => set({ kind: v })}
          />
          <ItemFilters
            choices={choices}
            filters={filters}
            keys={DEAD_KEYS}
            onChange={(k, v) => set({ [k]: v })}
          />
        </>
      }
      printFilters={[
        s(t, 'dead.daysN', { count: days }),
        ...filterWords(t, choices, filters, DEAD_KEYS),
      ].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? KINDS.map((k) => ({
              key: k,
              label: s(t, `dead.kinds.${k}`),
              value: values
                ? `${report.totals[k].count} · ${moneyText(report.totals[k].value, m)}`
                : String(report.totals[k].count),
              ...(k === 'dead' && report.totals.dead.count > 0 ? { tone: 'bad' as const } : {}),
            }))
          : []
      }
    >
      {report && m && (
        <>
          <Truncated shown={report.truncated} />
          <ListTable
            label={t('nav.deadStock')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.itemId}
            text={(r) => `${r.code} ${r.name} ${r.category ?? ''} ${r.make ?? ''}`}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Inventory analysis (RPT-14, owner answer 7) ----

export function InventoryAnalysisScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('inventoryAnalysis');
  const choices = useChoices(api);
  const keys: ChoiceKey[] = ['categoryId', 'makeId', 'brandId', 'supplierId'];
  // No period chosen: the last 12 months, worked out by the API (owner answer 7).
  const chosen = filters['preset'] || (filters['from'] && filters['to']);
  const query = only(filters, ['preset', 'from', 'to', ...keys]);
  const url = `/api/reports/inventory-analysis?${apiQuery(query)}`;
  const { report, error } = useReport<AnalysisView>(api, url);
  const m = report?.money;
  const period: PeriodValue = chosen
    ? periodOf(filters, 'thisYear')
    : { from: report?.from ?? '', to: report?.to ?? '' };
  const set = (next: Filters) =>
    setFilters(only({ ...current(filters), ...next }, ['preset', 'from', 'to', ...keys]));
  const values = report?.values === true;
  const number = (x: number | null, digits = 0) =>
    x === null || !m
      ? '—'
      : new Intl.NumberFormat(m.locale, {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(x);
  const columns: ListColumn<AnalysisRow>[] = [
    {
      key: 'code',
      label: s(t, 'code'),
      sort: (r) => r.code,
      cell: (r) => <a href={stockLedgerHref(r.itemId)}>{r.code}</a>,
    },
    { key: 'name', label: s(t, 'name'), sort: (r) => r.name, cell: (r) => r.name },
    {
      key: 'category',
      label: s(t, 'filter.categoryId'),
      sort: (r) => r.category ?? '',
      cell: (r) => r.category ?? '',
    },
    {
      key: 'qtySold',
      label: s(t, 'analysis.qtySold'),
      end: true,
      sort: (r) => r.qtySold,
      cell: (r) => qtyText(r.qtySold),
    },
    {
      key: 'sales',
      label: s(t, 'analysis.sales'),
      end: true,
      sort: (r) => r.sales,
      cell: (r) => (m ? moneyText(r.sales, m) : ''),
    },
    {
      key: 'salesClass',
      label: s(t, 'analysis.salesClass'),
      sort: (r) => r.salesClass ?? 'Z',
      cell: (r) => r.salesClass ?? '—',
    },
    ...(values && m
      ? [
          {
            key: 'profit',
            label: s(t, 'analysis.profit'),
            end: true,
            sort: (r: AnalysisRow) => r.profit ?? 0,
            cell: (r: AnalysisRow) => moneyText(r.profit, m),
          },
          {
            key: 'profitClass',
            label: s(t, 'analysis.profitClass'),
            sort: (r: AnalysisRow) => r.profitClass ?? 'Z',
            cell: (r: AnalysisRow) => r.profitClass ?? '—',
          },
        ]
      : []),
    {
      key: 'onHand',
      label: s(t, 'reorder.onHand'),
      end: true,
      sort: (r) => r.onHand,
      cell: (r) => qtyText(r.onHand),
    },
    ...(values && m
      ? [
          {
            key: 'stockValue',
            label: s(t, 'value'),
            end: true,
            sort: (r: AnalysisRow) => r.stockValue ?? 0,
            cell: (r: AnalysisRow) => moneyText(r.stockValue, m),
          },
        ]
      : []),
    {
      key: 'cover',
      label: s(t, 'daysOfCover'),
      end: true,
      sort: (r) => r.daysOfCover ?? -1,
      cell: (r) => r.daysOfCover ?? '—',
    },
  ];
  return (
    <ReportPage
      title={t('nav.inventoryAnalysis')}
      help={s(t, 'analysis.help')}
      eyebrow={report ? s(t, 'since', { date: report.since }) : undefined}
      filters={
        <>
          <PeriodFilter
            value={period}
            shown={report}
            onChange={(p) => set({ from: '', to: '', preset: '', ...periodQuery(p) })}
          />
          <ItemFilters choices={choices} filters={filters} keys={keys} onChange={(k, v) => set({ [k]: v })} />
        </>
      }
      printFilters={[periodWords(report), ...filterWords(t, choices, filters, keys)].join(' · ')}
      csv={report && `${url}${url.endsWith('?') ? '' : '&'}format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              ...(['A', 'B', 'C'] as const).map((k) => ({
                key: k,
                label: s(t, 'analysis.class', { name: k }),
                value: `${report.classes[k].count} · ${moneyText(report.classes[k].sales, m)}`,
              })),
              { key: 'unsold', label: s(t, 'analysis.unsold'), value: String(report.unsold.count) },
              ...(values
                ? [
                    {
                      key: 'turnover',
                      label: s(t, 'analysis.turnover'),
                      value: report.turnover === null ? '—' : `${number(report.turnover / 100, 2)}×`,
                    },
                    {
                      key: 'cost',
                      label: s(t, 'analysis.costOfSales'),
                      value: moneyText(report.costOfSales, m),
                    },
                  ]
                : []),
            ]
          : []
      }
    >
      {report && m && (
        <>
          <Truncated shown={report.truncated} />
          <ListTable
            label={t('nav.inventoryAnalysis')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.itemId}
            text={(r) => `${r.code} ${r.name} ${r.category ?? ''}`}
          />
        </>
      )}
    </ReportPage>
  );
}
