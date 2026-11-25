import {
  GRID_MEASURES,
  SALES_COMPARES,
  SALES_GROUPS,
  SALES_RANKINGS,
  WALK_IN,
  type DiscountRowView,
  type PurchaseDocumentRow,
  type PurchaseRegisterView,
  type RateLineView,
  type RatesView,
  type RateStatsView,
  type SalesChoicesView,
  type SalesCorrections,
  type SalesGroup,
  type SalesOverTimeView,
  type SalesProfitView,
  type SalesRow,
  type StockChoicesView,
  type TopItemView,
} from '@erp/contracts';
import { Button, Checkbox, Label, LABEL_CLASS, TableCell, TableRow, type MoneyFormat } from '@erp/ui';
import type { TFunction } from 'i18next';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { ItemPicker } from '../purchasing/ItemPicker';
import { href, queryOf, withQuery } from '../router';
import { BarList, ChartPanel, HourGridChart, TrendChart } from './frame/Charts';
import { apiQuery, useFilters, type Filters } from './frame/filters';
import { documentHref } from './frame/links';
import {
  ChoiceFilter,
  ListTable,
  moneyText,
  PeriodFilter,
  periodOf,
  periodQuery,
  percentText,
  periodWords,
  ReportPage,
  useReport,
  type Figure,
  type ListColumn,
  type PeriodValue,
} from './frame/ReportFrame';

// The sales and purchase reports (W2-03 plan; RPT-07, RPT-09, RPT-15; owner answers 1–6; D-116), each on the report
// frame. Read only; every one needs reports.view, and cost, profit, purchase amounts and purchase rates come only with
// cost.view (the API leaves them out). Quantities are thousandths, shown as the stock screens show them.

const s = (t: TFunction, key: string, o?: Record<string, unknown>) =>
  t(`reports.salesReports.${key}`, o ?? {});

/**
 * The filters now: the address's, which a change before the screen caught up (two quick changes) already moved, else
 * the ones the screen was drawn with.
 */
function current(filters: Filters): Filters {
  const q = queryOf(window.location.hash);
  return q.size > 0 ? Object.fromEntries(q) : filters;
}

/** Only the filters an API takes, without empty ones. */
const only = (f: Filters, keys: readonly string[]): Filters =>
  Object.fromEntries(keys.filter((k) => f[k]).map((k) => [k, f[k]!]));

/** The filters' choices: categories, makes, brands, locations and suppliers (the stock reports'), salesmen, customers. */
function useChoices(api: Api) {
  const stock = useReport<StockChoicesView>(api, '/api/reports/stock-choices').report;
  const sales = useReport<SalesChoicesView>(api, '/api/reports/sales-choices').report;
  return { stock, sales };
}
type Choices = ReturnType<typeof useChoices>;

type ChoiceKey =
  'categoryId' | 'brandId' | 'makeId' | 'salesmanId' | 'customerId' | 'locationId' | 'supplierId';

function optionsOf(t: TFunction, c: Choices, k: ChoiceKey): { value: string; label: string }[] {
  const named = (rows: { id: string; name: string }[] | undefined) =>
    (rows ?? []).map((r) => ({ value: r.id, label: r.name }));
  switch (k) {
    case 'categoryId':
      return named(c.stock?.categories);
    case 'brandId':
      return named(c.stock?.brands);
    case 'makeId':
      return named(c.stock?.makes);
    case 'locationId':
      return named(c.stock?.locations);
    case 'supplierId':
      return named(c.stock?.suppliers);
    case 'salesmanId':
      return named(c.sales?.salesmen);
    case 'customerId':
      return [{ value: WALK_IN, label: s(t, 'walkIn') }, ...named(c.sales?.customers)];
  }
}

/** Dropdowns for the filters: all, or one. */
function Dropdowns({
  choices,
  filters,
  keys,
  onChange,
}: {
  choices: Choices;
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
          options={[{ value: '', label: s(t, 'all') }, ...optionsOf(t, choices, k)]}
          onChange={(v) => onChange(k, v)}
        />
      ))}
    </>
  );
}

/** The chosen filters in words, for the printed header. */
function filterWords(t: TFunction, choices: Choices, filters: Filters, keys: ChoiceKey[]) {
  return keys
    .filter((k) => filters[k])
    .map((k) => {
      const o = optionsOf(t, choices, k).find((x) => x.value === filters[k]);
      return `${s(t, `filter.${k}`)}: ${o?.label ?? ''}`;
    });
}

const money = (m: MoneyFormat) => (v: number | null) => moneyText(v, m);

/** "Before go-live" when the comparison period starts before the system had sales (owner answer 1 of W2-02). */
function BeforeNote({ report }: { report: { before: { from: string } | null; since: string } }) {
  const { t } = useTranslation();
  return report.before && report.before.from < report.since ? (
    <p className="m-0 text-sm text-muted-foreground">{s(t, 'beforeGoLive', { since: report.since })}</p>
  ) : null;
}

// ---- Sales and gross profit (RPT-07, owner answers 1–3) ----

const PROFIT_KEYS: ChoiceKey[] = [
  'categoryId',
  'brandId',
  'makeId',
  'salesmanId',
  'customerId',
  'locationId',
];
const PROFIT_QUERY = ['preset', 'from', 'to', 'group', 'compare', 'itemId', ...PROFIT_KEYS];

const groupOf = (f: Filters): SalesGroup => SALES_GROUPS.find((g) => g === f['group']) ?? 'category';

/** Where a row opens: the next level down, in the same period and filters (owner answer 3); a bill its trace. */
function drillOf(group: SalesGroup, row: SalesRow, base: Filters): string | null {
  const to = (next: Filters) => withQuery(href.salesProfit, only({ ...base, ...next }, PROFIT_QUERY));
  switch (group) {
    case 'category':
      return row.key ? to({ group: 'item', categoryId: row.key }) : null;
    case 'brand':
      return row.key ? to({ group: 'item', brandId: row.key }) : null;
    case 'make':
      return row.key ? to({ group: 'item', makeId: row.key }) : null;
    case 'salesman':
      return to({ group: 'item', salesmanId: row.key });
    case 'customer':
      return to({ group: 'bill', customerId: row.key || WALK_IN });
    case 'item':
      return to({ group: 'bill', itemId: row.key });
    case 'bill':
      return row.code ? href.trace(row.code) : null;
    case 'day':
      return to({ group: 'bill', preset: '', from: row.key, to: row.key });
    case 'month': {
      const [y, mo] = row.key.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      return to({
        group: 'day',
        preset: '',
        from: `${row.key}-01`,
        to: `${row.key}-${String(last).padStart(2, '0')}`,
      });
    }
  }
}

export function SalesProfitScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('salesProfit');
  const choices = useChoices(api);
  const period = periodOf(filters, 'thisMonth');
  const group = groupOf(filters);
  const compare = SALES_COMPARES.find((c) => c === filters['compare']) ?? 'previous';
  const query = only({ ...filters, ...periodQuery(period), group, compare }, PROFIT_QUERY);
  const url = `/api/reports/sales-profit?${apiQuery(query)}`;
  const { report, error } = useReport<SalesProfitView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, PROFIT_QUERY));
  const setPeriod = (p: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, PROFIT_QUERY));
  const values = report?.values === true;
  const compared = report?.before !== null && report?.before !== undefined;
  const nameOf = (r: SalesRow) =>
    r.name === '' ? s(t, `none.${group}`) : r.date && group === 'bill' ? `${r.name} · ${r.date}` : r.name;
  const columns: ListColumn<SalesRow>[] = m
    ? [
        {
          key: 'name',
          label: s(t, `group.${group}`),
          sort: (r) => (group === 'bill' ? (r.date ?? '') + (r.code ?? '') : r.name),
          cell: (r) => {
            const to = drillOf(group, r, query);
            const text = (
              <>
                {r.code && group !== 'bill' && (
                  <span className="me-2 font-mono text-muted-foreground">{r.code}</span>
                )}
                {nameOf(r)}
              </>
            );
            return to ? <a href={to}>{text}</a> : text;
          },
        },
        {
          key: 'bills',
          label: s(t, 'bills'),
          end: true,
          sort: (r) => r.cells.bills,
          cell: (r) => r.cells.bills,
        },
        {
          key: 'qty',
          label: s(t, 'qty'),
          end: true,
          sort: (r) => r.cells.qty,
          cell: (r) => qtyText(r.cells.qty),
        },
        {
          key: 'sales',
          label: s(t, 'sales'),
          end: true,
          sort: (r) => r.cells.sales,
          cell: (r) => moneyText(r.cells.sales, m),
        },
        {
          key: 'discount',
          label: s(t, 'discount'),
          end: true,
          sort: (r) => r.cells.discount,
          cell: (r) => moneyText(r.cells.discount, m),
        },
        ...(values
          ? [
              {
                key: 'cost',
                label: s(t, 'cost'),
                end: true,
                sort: (r: SalesRow) => r.cells.cost ?? 0,
                cell: (r: SalesRow) => moneyText(r.cells.cost, m),
              },
              {
                key: 'profit',
                label: s(t, 'profit'),
                end: true,
                sort: (r: SalesRow) => r.cells.profit ?? 0,
                cell: (r: SalesRow) => moneyText(r.cells.profit, m),
              },
              {
                key: 'margin',
                label: s(t, 'margin'),
                end: true,
                sort: (r: SalesRow) => r.cells.marginBp ?? -Infinity,
                cell: (r: SalesRow) => percentText(r.cells.marginBp, m.locale),
              },
            ]
          : []),
        ...(compared
          ? [
              {
                key: 'beforeSales',
                label: s(t, 'beforeSales'),
                end: true,
                sort: (r: SalesRow) => r.before?.sales ?? 0,
                cell: (r: SalesRow) => moneyText(r.before?.sales ?? null, m),
              },
              {
                key: 'change',
                label: s(t, 'change'),
                end: true,
                sort: (r: SalesRow) => r.before?.salesChange.bp ?? -Infinity,
                cell: (r: SalesRow) => percentText(r.before?.salesChange.bp ?? null, m.locale),
              },
            ]
          : []),
      ]
    : [];
  const total = report?.total;
  const footer =
    total && m
      ? [
          s(t, 'total'),
          String(total.cells.bills),
          qtyText(total.cells.qty),
          moneyText(total.cells.sales, m),
          moneyText(total.cells.discount, m),
          ...(values
            ? [
                moneyText(total.cells.cost, m),
                moneyText(total.cells.profit, m),
                percentText(total.cells.marginBp, m.locale),
              ]
            : []),
          ...(compared
            ? [
                moneyText(total.before?.sales ?? null, m),
                percentText(total.before?.salesChange.bp ?? null, m.locale),
              ]
            : []),
        ]
      : undefined;
  const figures: Figure[] =
    report && m
      ? [
          { key: 'sales', label: s(t, 'sales'), value: moneyText(report.total.cells.sales, m) },
          ...(values
            ? [
                { key: 'profit', label: s(t, 'profit'), value: moneyText(report.total.cells.profit, m) },
                {
                  key: 'margin',
                  label: s(t, 'margin'),
                  value: percentText(report.total.cells.marginBp, m.locale),
                },
              ]
            : []),
          ...(report.corrections && report.corrections.cost !== 0
            ? [
                {
                  key: 'profitInBooks',
                  label: s(t, 'corrections.profit'),
                  value: moneyText(report.corrections.profit, m),
                },
              ]
            : []),
          { key: 'discount', label: s(t, 'discount'), value: moneyText(report.total.cells.discount, m) },
          { key: 'bills', label: s(t, 'bills'), value: String(report.total.cells.bills) },
          ...(report.total.before
            ? [
                {
                  key: 'change',
                  label: s(t, 'changeSales'),
                  value: percentText(report.total.before.salesChange.bp, m.locale),
                  ...(report.total.before.salesChange.amount < 0 ? { tone: 'bad' as const } : {}),
                },
              ]
            : []),
        ]
      : [];
  return (
    <ReportPage
      title={t('nav.salesProfit')}
      help={s(t, 'help.profit')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <ChoiceFilter
            label={s(t, 'groupBy')}
            value={group}
            options={SALES_GROUPS.map((g) => ({ value: g, label: s(t, `group.${g}`) }))}
            onChange={(v) => set({ group: v })}
          />
          <ChoiceFilter
            label={t('reports.pl.compare')}
            value={compare}
            options={SALES_COMPARES.map((c) => ({ value: c, label: t(`reports.pl.compareTo.${c}`) }))}
            onChange={(v) => set({ compare: v })}
          />
          <Dropdowns
            choices={choices}
            filters={filters}
            keys={PROFIT_KEYS}
            onChange={(k, v) => set({ [k]: v })}
          />
          {filters['itemId'] && (
            <Button variant="outline" onClick={() => set({ itemId: '' })}>
              <X aria-hidden="true" className="size-4" />
              {s(t, 'anyItem')}
            </Button>
          )}
        </>
      }
      printFilters={[
        periodWords(report),
        s(t, `group.${group}`),
        t(`reports.pl.compareTo.${compare}`),
        ...filterWords(t, choices, filters, PROFIT_KEYS),
      ].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={figures}
    >
      {report && m && (
        <>
          <BeforeNote report={report} />
          {report.truncated && <p className="m-0 text-sm text-muted-foreground">{s(t, 'truncated')}</p>}
          <ListTable
            label={t('nav.salesProfit')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.key || '-'}
            text={(r) => `${r.code ?? ''} ${nameOf(r)}`}
            {...(footer ? { footer } : {})}
          />
          {report.corrections && report.corrections.items.length > 0 && (
            <Corrections corrections={report.corrections} m={m} />
          )}
        </>
      )}
    </ReportPage>
  );
}

/**
 * Stock sold before it arrived, settled when it came in (D-124, owner answer 1 to W2-09): cost of goods sold on no
 * bill, by item, then gross profit in the books.
 */
function Corrections({ corrections, m }: { corrections: SalesCorrections; m: MoneyFormat }) {
  const { t } = useTranslation();
  type Item = SalesCorrections['items'][number];
  const columns: ListColumn<Item>[] = [
    { key: 'name', label: s(t, 'group.item'), sort: (r) => r.code, cell: (r) => `${r.code} ${r.name}` },
    { key: 'cost', label: s(t, 'cost'), end: true, sort: (r) => r.cost, cell: (r) => moneyText(r.cost, m) },
  ];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="m-0 text-base font-semibold">{s(t, 'corrections.title')}</h3>
      <p className="m-0 text-sm text-muted-foreground">{s(t, 'corrections.help')}</p>
      <ListTable
        label={s(t, 'corrections.title')}
        columns={columns}
        rows={corrections.items}
        rowKey={(r) => r.itemId}
        text={(r) => `${r.code} ${r.name}`}
        footer={[s(t, 'total'), moneyText(corrections.cost, m)]}
      />
      <p className="m-0 font-semibold">
        {s(t, 'corrections.profit')}: <span className="tabular-nums">{moneyText(corrections.profit, m)}</span>
      </p>
    </section>
  );
}

// ---- The purchase register (RPT-09) ----

const REGISTER_QUERY = ['preset', 'from', 'to', 'supplierId', 'lines'];

export function PurchaseRegisterScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('purchaseRegister');
  const choices = useChoices(api);
  const period = periodOf(filters, 'thisMonth');
  const url = `/api/reports/purchase-register?${apiQuery(only({ ...filters, ...periodQuery(period) }, REGISTER_QUERY))}`;
  const { report, error } = useReport<PurchaseRegisterView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, REGISTER_QUERY));
  const setPeriod = (p: PeriodValue) =>
    setFilters(
      only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, REGISTER_QUERY),
    );
  const values = report?.values === true;
  const withLines = filters['lines'] === '1';
  const columns: ListColumn<PurchaseDocumentRow>[] = [
    { key: 'date', label: s(t, 'date'), sort: (r) => `${r.date}${r.number ?? ''}`, cell: (r) => r.date },
    {
      key: 'number',
      label: t('reports.frame.document'),
      sort: (r) => r.number ?? '',
      cell: (r) => {
        const to = documentHref(r.kind === 'receipt' ? 'goods_receipt' : 'purchase_return', r.id, r.number);
        return to ? <a href={to}>{r.number}</a> : r.number;
      },
    },
    {
      key: 'kind',
      label: s(t, 'register.kind'),
      sort: (r) => r.kind,
      cell: (r) => s(t, `register.kinds.${r.kind}`),
    },
    {
      key: 'supplier',
      label: s(t, 'filter.supplierId'),
      sort: (r) => r.supplier ?? '￿',
      cell: (r) => r.supplier ?? '—',
    },
    {
      key: 'bill',
      label: s(t, 'register.supplierBill'),
      sort: (r) => r.supplierBillNo ?? '',
      cell: (r) => [r.supplierBillNo, r.supplierBillDate].filter(Boolean).join(' · '),
    },
    { key: 'location', label: s(t, 'filter.locationId'), sort: (r) => r.location, cell: (r) => r.location },
    {
      key: 'paidBy',
      label: s(t, 'register.paidBy'),
      sort: (r) => r.paidBy,
      cell: (r) => s(t, `register.paid.${r.paidBy}`),
    },
    { key: 'due', label: s(t, 'register.due'), sort: (r) => r.dueDate ?? '', cell: (r) => r.dueDate ?? '' },
    { key: 'qty', label: s(t, 'qty'), end: true, sort: (r) => r.qty, cell: (r) => qtyText(r.qty) },
    ...(values && m
      ? [
          {
            key: 'total',
            label: s(t, 'register.total'),
            end: true,
            sort: (r: PurchaseDocumentRow) => r.total ?? 0,
            cell: (r: PurchaseDocumentRow) => moneyText(r.total, m),
          },
        ]
      : []),
  ];
  return (
    <ReportPage
      title={t('nav.purchaseRegister')}
      help={s(t, 'help.register')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <Dropdowns
            choices={choices}
            filters={filters}
            keys={['supplierId']}
            onChange={(k, v) => set({ [k]: v })}
          />
          <div className="flex h-9 items-center gap-2">
            <Checkbox
              id="register-lines"
              checked={withLines}
              onCheckedChange={(c) => set({ lines: c === true ? '1' : '' })}
            />
            <Label htmlFor="register-lines">{s(t, 'register.withLines')}</Label>
          </div>
        </>
      }
      printFilters={[periodWords(report), ...filterWords(t, choices, filters, ['supplierId'])].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'count', label: s(t, 'register.documents'), value: String(report.total.count) },
              ...(values
                ? [
                    {
                      key: 'receipts',
                      label: s(t, 'register.receipts'),
                      value: moneyText(report.total.receipts, m),
                    },
                    {
                      key: 'returns',
                      label: s(t, 'register.returns'),
                      value: moneyText(report.total.returns, m),
                    },
                    { key: 'net', label: s(t, 'register.net'), value: moneyText(report.total.net, m) },
                  ]
                : []),
            ]
          : []
      }
    >
      {report && m && (
        <>
          <ListTable
            label={t('nav.purchaseRegister')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.id}
            text={(r) => `${r.number ?? ''} ${r.supplier ?? ''} ${r.supplierBillNo ?? ''}`}
            details={(r) =>
              (r.lines ?? []).map((l, i) => (
                <TableRow key={`${r.id}:${i}`} className="text-muted-foreground">
                  <TableCell />
                  <TableCell colSpan={columns.length - 3}>
                    <span className="me-2 font-mono">{l.code}</span>
                    {l.name}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{qtyText(l.qty)}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {values ? `${moneyText(l.rate, m)} → ${moneyText(l.value, m)}` : ''}
                  </TableCell>
                </TableRow>
              ))
            }
          />
          <ListTable
            label={s(t, 'register.bySupplier')}
            columns={[
              {
                key: 'name',
                label: s(t, 'filter.supplierId'),
                sort: (r) => r.name ?? '￿',
                cell: (r) => r.name ?? '—',
              },
              {
                key: 'count',
                label: s(t, 'register.documents'),
                end: true,
                sort: (r) => r.count,
                cell: (r) => r.count,
              },
              ...(values
                ? [
                    {
                      key: 'total',
                      label: s(t, 'register.net'),
                      end: true,
                      sort: (r: PurchaseRegisterView['suppliers'][number]) => r.total ?? 0,
                      cell: (r: PurchaseRegisterView['suppliers'][number]) => moneyText(r.total, m),
                    },
                  ]
                : []),
            ]}
            rows={report.suppliers}
            rowKey={(r) => r.supplierId ?? '-'}
            text={(r) => r.name ?? ''}
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Purchase and sale rates (RPT-09, owner answer 4) ----

const RATES_QUERY = ['itemId', 'partyId', 'preset', 'from', 'to'];

function StatsFigures(
  t: TFunction,
  side: 'purchase' | 'sale',
  st: RateStatsView | null,
  m: MoneyFormat,
): Figure[] {
  if (!st || st.count === 0) return [];
  return [
    { key: `${side}Avg`, label: s(t, `rates.${side}Average`), value: moneyText(st.average, m) },
    { key: `${side}Last`, label: s(t, `rates.${side}Last`), value: moneyText(st.last, m) },
    {
      key: `${side}Range`,
      label: s(t, `rates.${side}Range`),
      value: `${moneyText(st.lowest, m)} – ${moneyText(st.highest, m)}`,
    },
  ];
}

export function RatesScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('rates');
  const period = periodOf(filters, 'thisYear');
  const picked = filters['itemId'] || filters['partyId'];
  const url = picked
    ? `/api/reports/rates?${apiQuery(only({ ...filters, ...periodQuery(period) }, RATES_QUERY))}`
    : null;
  const { report, error } = useReport<RatesView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, RATES_QUERY));
  const setPeriod = (p: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, RATES_QUERY));
  const columns = (kind: RateLineView['kind']): ListColumn<RateLineView>[] =>
    m
      ? [
          {
            key: 'date',
            label: s(t, 'date'),
            sort: (l) => `${l.date}${l.number ?? ''}`,
            cell: (l) => l.date,
          },
          {
            key: 'number',
            label: t('reports.frame.document'),
            sort: (l) => l.number ?? '',
            cell: (l) => {
              const to = documentHref(kind === 'receipt' ? 'goods_receipt' : 'sale', l.documentId, l.number);
              return to ? <a href={to}>{l.number}</a> : l.number;
            },
          },
          {
            key: 'party',
            label: s(t, kind === 'receipt' ? 'filter.supplierId' : 'filter.customerId'),
            sort: (l) => l.party ?? '',
            cell: (l) => l.party ?? s(t, 'walkIn'),
          },
          ...(kind === 'sale'
            ? [
                {
                  key: 'salesman',
                  label: s(t, 'filter.salesmanId'),
                  cell: (l: RateLineView) => l.salesman ?? '',
                },
              ]
            : []),
          ...(report?.item
            ? []
            : [
                {
                  key: 'item',
                  label: s(t, 'group.item'),
                  sort: (l: RateLineView) => l.code,
                  cell: (l: RateLineView) => `${l.code} ${l.name}`,
                },
              ]),
          { key: 'qty', label: s(t, 'qty'), end: true, sort: (l) => l.qty, cell: (l) => qtyText(l.qty) },
          ...(kind === 'sale'
            ? [
                {
                  key: 'list',
                  label: s(t, 'rates.list'),
                  end: true,
                  cell: (l: RateLineView) => moneyText(l.listPrice, m),
                },
              ]
            : []),
          {
            key: 'rate',
            label: s(t, kind === 'receipt' ? 'rates.billRate' : 'rates.price'),
            end: true,
            sort: (l) => l.rate,
            cell: (l) => moneyText(l.rate, m),
          },
          {
            key: 'net',
            label: s(t, 'rates.netRate'),
            end: true,
            sort: (l) => l.netRate,
            cell: (l) => moneyText(l.netRate, m),
          },
        ]
      : [];
  return (
    <ReportPage
      title={
        report?.item
          ? `${report.item.code} ${report.item.name}`
          : report?.party
            ? report.party.name
            : t('nav.rates')
      }
      eyebrow={report?.item || report?.party ? t('nav.rates') : undefined}
      help={s(t, 'help.rates')}
      filters={
        <>
          {(['item', 'party'] as const).map((k) => {
            const id = `${k}Id`;
            const chosen = k === 'item' ? report?.item : report?.party;
            return (
              <div key={k} className="flex w-80 max-w-full flex-col gap-1">
                <span className={LABEL_CLASS}>{s(t, `rates.${k}`)}</span>
                <div className="flex gap-1">
                  <div className="flex-1">
                    <ItemPicker
                      api={api}
                      url={k === 'item' ? '/api/reports/items' : '/api/reports/parties'}
                      label={s(t, `rates.${k}`)}
                      picked={chosen ?? null}
                      onPick={(x) => set({ [id]: x.id })}
                    />
                  </div>
                  {filters[id] && (
                    <Button
                      variant="ghost"
                      aria-label={s(t, `rates.clear.${k}`)}
                      onClick={() => set({ [id]: '' })}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
        </>
      }
      printFilters={periodWords(report)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={url !== null && report === null}
      figures={
        report && m
          ? [
              ...StatsFigures(t, 'purchase', report.purchaseStats, m),
              ...StatsFigures(t, 'sale', report.saleStats, m),
              ...(report.spread
                ? [
                    { key: 'spread', label: s(t, 'rates.spread'), value: moneyText(report.spread.amount, m) },
                    {
                      key: 'spreadMargin',
                      label: s(t, 'margin'),
                      value: percentText(report.spread.marginBp, m.locale),
                      ...(report.spread.amount < 0 ? { tone: 'bad' as const } : {}),
                    },
                  ]
                : []),
            ]
          : []
      }
    >
      {!picked && <p className="text-muted-foreground">{s(t, 'rates.pick')}</p>}
      {report && m && (
        <>
          {!report.item && <p className="m-0 text-sm text-muted-foreground">{s(t, 'rates.manyItems')}</p>}
          {report.purchases && (
            <section className="flex flex-col gap-2">
              <h2 className="m-0 text-base font-semibold">{s(t, 'rates.purchases')}</h2>
              <ListTable
                label={s(t, 'rates.purchases')}
                columns={columns('receipt')}
                rows={report.purchases}
                rowKey={(l) => `${l.documentId}:${l.itemId}:${l.qty}:${l.rate}`}
                text={(l) => `${l.number ?? ''} ${l.party ?? ''} ${l.code} ${l.name}`}
              />
            </section>
          )}
          <section className="flex flex-col gap-2">
            <h2 className="m-0 text-base font-semibold">{s(t, 'rates.sales')}</h2>
            <ListTable
              label={s(t, 'rates.sales')}
              columns={columns('sale')}
              rows={report.sales}
              rowKey={(l) => `${l.documentId}:${l.itemId}:${l.qty}:${l.rate}`}
              text={(l) => `${l.number ?? ''} ${l.party ?? ''} ${l.salesman ?? ''} ${l.code} ${l.name}`}
            />
          </section>
        </>
      )}
    </ReportPage>
  );
}

// ---- Sales over time (RPT-15, owner answers 5 and 6) ----

const TIME_KEYS: ChoiceKey[] = ['categoryId', 'salesmanId', 'locationId'];
const TIME_QUERY = ['preset', 'from', 'to', 'compare', 'by', 'measure', ...TIME_KEYS];

/** Monday first, in the shop's language. */
const weekdaysOf = (locale: string) =>
  Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + i)),
  );
const hourOf = (locale: string) => (h: number) =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1, h));
const dayOf = (locale: string) => (date: string) =>
  new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    Date.parse(date),
  );

export function SalesOverTimeScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('salesOverTime');
  const choices = useChoices(api);
  const period = periodOf(filters, 'thisMonth');
  const compare = SALES_COMPARES.find((c) => c === filters['compare']) ?? 'previous';
  const by = SALES_RANKINGS.find((r) => r === filters['by']) ?? 'sales';
  const measure = GRID_MEASURES.find((x) => x === filters['measure']) ?? 'bills';
  const url = `/api/reports/sales-over-time?${apiQuery(
    only(
      { ...filters, ...periodQuery(period), compare, by },
      TIME_QUERY.filter((k) => k !== 'measure'),
    ),
  )}`;
  const { report, error } = useReport<SalesOverTimeView>(api, url);
  const m = report?.money;
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, TIME_QUERY));
  const setPeriod = (p: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, TIME_QUERY));
  const values = report?.values === true;
  const total = report && {
    sales: report.trend.reduce((a, x) => a + x.sales, 0),
    bills: report.trend.reduce((a, x) => a + x.bills, 0),
    profit: values ? report.trend.reduce((a, x) => a + (x.profit ?? 0), 0) : null,
  };
  const pointLabel = (p: { from: string; to: string }) => (p.from === p.to ? p.from : `${p.from} – ${p.to}`);
  const topColumns: ListColumn<TopItemView>[] = m
    ? [
        {
          key: 'item',
          label: s(t, 'group.item'),
          sort: (r) => r.code,
          cell: (r) => (
            <a href={withQuery(href.rates, { itemId: r.itemId })}>
              <span className="me-2 font-mono text-muted-foreground">{r.code}</span>
              {r.name}
            </a>
          ),
        },
        { key: 'qty', label: s(t, 'qty'), end: true, sort: (r) => r.qty, cell: (r) => qtyText(r.qty) },
        {
          key: 'sales',
          label: s(t, 'sales'),
          end: true,
          sort: (r) => r.sales,
          cell: (r) => moneyText(r.sales, m),
        },
        ...(values
          ? [
              {
                key: 'profit',
                label: s(t, 'profit'),
                end: true,
                sort: (r: TopItemView) => r.profit ?? 0,
                cell: (r: TopItemView) => moneyText(r.profit, m),
              },
            ]
          : []),
      ]
    : [];
  const discountColumns = (first: string): ListColumn<DiscountRowView>[] =>
    m
      ? [
          { key: 'name', label: first, sort: (r) => r.name, cell: (r) => r.name },
          {
            key: 'list',
            label: s(t, 'overTime.listSales'),
            end: true,
            sort: (r) => r.listSales,
            cell: (r) => moneyText(r.listSales, m),
          },
          {
            key: 'sales',
            label: s(t, 'sales'),
            end: true,
            sort: (r) => r.sales,
            cell: (r) => moneyText(r.sales, m),
          },
          {
            key: 'discount',
            label: s(t, 'discount'),
            end: true,
            sort: (r) => r.discount,
            cell: (r) => moneyText(r.discount, m),
          },
          {
            key: 'share',
            label: s(t, 'overTime.discountShare'),
            end: true,
            sort: (r) => r.discountBp ?? -Infinity,
            cell: (r) => percentText(r.discountBp, m.locale),
          },
          {
            key: 'approvals',
            label: s(t, 'overTime.approvals'),
            end: true,
            sort: (r) => r.approvals,
            cell: (r) =>
              r.approvals > 0 ? <a href={href.overridesReport}>{r.approvals}</a> : String(r.approvals),
          },
        ]
      : [];
  const measureOf = (r: TopItemView) => (by === 'qty' ? r.qty : by === 'profit' ? (r.profit ?? 0) : r.sales);
  const showMeasure = (v: number) => (m ? (by === 'qty' ? qtyText(v) : moneyText(v, m)) : '');
  return (
    <ReportPage
      title={t('nav.salesOverTime')}
      help={s(t, 'help.overTime')}
      filters={
        <>
          <PeriodFilter value={period} shown={report} onChange={setPeriod} />
          <ChoiceFilter
            label={t('reports.pl.compare')}
            value={compare}
            options={SALES_COMPARES.map((c) => ({ value: c, label: t(`reports.pl.compareTo.${c}`) }))}
            onChange={(v) => set({ compare: v })}
          />
          <Dropdowns
            choices={choices}
            filters={filters}
            keys={TIME_KEYS}
            onChange={(k, v) => set({ [k]: v })}
          />
        </>
      }
      printFilters={[
        periodWords(report),
        t(`reports.pl.compareTo.${compare}`),
        ...filterWords(t, choices, filters, TIME_KEYS),
      ].join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m && total
          ? [
              { key: 'sales', label: s(t, 'sales'), value: moneyText(total.sales, m) },
              ...(values
                ? [{ key: 'profit', label: s(t, 'profit'), value: moneyText(total.profit, m) }]
                : []),
              { key: 'bills', label: s(t, 'bills'), value: String(total.bills) },
              {
                key: 'discount',
                label: s(t, 'discount'),
                value: moneyText(report.discounts.total.discount, m),
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <BeforeNote report={report} />
          <ChartPanel
            title={s(t, `overTime.trend.${report.step}`)}
            legend={[
              { label: periodWords(report), tone: 1 },
              ...(report.before
                ? [{ label: periodWords(report.before), tone: 2 as const, dashed: true }]
                : []),
            ]}
          >
            <TrendChart
              label={s(t, `overTime.trend.${report.step}`)}
              points={report.trend.map(pointLabel)}
              tick={(i) => dayOf(m.locale)(report.trend[i]!.from)}
              format={money(m)}
              series={[
                { label: periodWords(report), tone: 1, values: report.trend.map((x) => x.sales) },
                ...(report.beforeTrend
                  ? [
                      {
                        label: periodWords(report.before),
                        tone: 2 as const,
                        dashed: true,
                        values: report.trend.map((_, i) => report.beforeTrend![i]?.sales ?? null),
                      },
                    ]
                  : []),
              ]}
            />
            <ListTable
              label={s(t, 'overTime.trendTable')}
              columns={[
                { key: 'when', label: s(t, 'date'), sort: (p) => p.from, cell: (p) => pointLabel(p) },
                { key: 'bills', label: s(t, 'bills'), end: true, sort: (p) => p.bills, cell: (p) => p.bills },
                {
                  key: 'sales',
                  label: s(t, 'sales'),
                  end: true,
                  sort: (p) => p.sales,
                  cell: (p) => moneyText(p.sales, m),
                },
                ...(values
                  ? [
                      {
                        key: 'profit',
                        label: s(t, 'profit'),
                        end: true,
                        sort: (p: SalesOverTimeView['trend'][number]) => p.profit ?? 0,
                        cell: (p: SalesOverTimeView['trend'][number]) => moneyText(p.profit, m),
                      },
                    ]
                  : []),
                ...(report.beforeTrend
                  ? [
                      {
                        key: 'before',
                        label: s(t, 'beforeSales'),
                        end: true,
                        cell: (p: SalesOverTimeView['trend'][number]) =>
                          moneyText(report.beforeTrend![report.trend.indexOf(p)]?.sales ?? null, m),
                      },
                    ]
                  : []),
              ]}
              rows={report.trend}
              rowKey={(p) => p.from}
              text={(p) => pointLabel(p)}
            />
          </ChartPanel>

          <ChartPanel title={s(t, 'overTime.hours')}>
            <div className="self-start">
              <ChoiceFilter
                label={s(t, 'overTime.measure')}
                value={measure}
                options={GRID_MEASURES.map((x) => ({ value: x, label: s(t, `overTime.measures.${x}`) }))}
                onChange={(v) => set({ measure: v })}
              />
            </div>
            {report.grid.hours ? (
              <HourGridChart
                label={s(t, 'overTime.hours')}
                values={report.grid[measure]}
                hours={report.grid.hours}
                weekdays={weekdaysOf(m.locale)}
                hourLabel={hourOf(m.locale)}
                format={(v) =>
                  measure === 'bills' ? s(t, 'overTime.billsN', { count: v }) : moneyText(v, m)
                }
              />
            ) : (
              <p className="m-0 text-muted-foreground">{t('reports.none')}</p>
            )}
          </ChartPanel>

          <ChartPanel title={s(t, 'overTime.top')}>
            <div className="self-start">
              <ChoiceFilter
                label={s(t, 'overTime.rankBy')}
                value={by}
                options={SALES_RANKINGS.filter((r) => values || r !== 'profit').map((r) => ({
                  value: r,
                  label: s(t, `overTime.rankings.${r}`),
                }))}
                onChange={(v) => set({ by: v })}
              />
            </div>
            <BarList
              label={s(t, 'overTime.top')}
              rows={report.top.map((r) => ({
                key: r.itemId,
                name: `${r.code} ${r.name}`,
                value: measureOf(r),
              }))}
              format={showMeasure}
            />
            <ListTable
              label={s(t, 'overTime.topTable')}
              columns={topColumns}
              rows={report.top}
              rowKey={(r) => r.itemId}
              text={(r) => `${r.code} ${r.name}`}
            />
          </ChartPanel>

          <ChartPanel title={s(t, 'overTime.bottom')}>
            <BarList
              label={s(t, 'overTime.bottom')}
              rows={report.bottom.map((r) => ({
                key: r.itemId,
                name: `${r.code} ${r.name}`,
                value: measureOf(r),
              }))}
              format={showMeasure}
            />
            <ListTable
              label={s(t, 'overTime.bottomTable')}
              columns={topColumns}
              rows={report.bottom}
              rowKey={(r) => r.itemId}
              text={(r) => `${r.code} ${r.name}`}
            />
          </ChartPanel>

          <section className="flex flex-col gap-2">
            <h2 className="m-0 text-base font-semibold">{s(t, 'overTime.discounts')}</h2>
            <p className="m-0 text-sm text-muted-foreground">{s(t, 'overTime.discountsHelp')}</p>
            <ListTable
              label={s(t, 'overTime.bySalesman')}
              columns={discountColumns(s(t, 'filter.salesmanId'))}
              rows={report.discounts.bySalesman}
              rowKey={(r) => r.key}
              text={(r) => r.name}
              footer={[
                s(t, 'total'),
                moneyText(report.discounts.total.listSales, m),
                moneyText(report.discounts.total.sales, m),
                moneyText(report.discounts.total.discount, m),
                percentText(report.discounts.total.discountBp, m.locale),
                String(report.discounts.total.approvals),
              ]}
            />
            <ListTable
              label={s(t, 'overTime.byDay')}
              columns={discountColumns(s(t, 'date'))}
              rows={report.discounts.byDay}
              rowKey={(r) => r.key}
              text={(r) => r.name}
            />
          </section>
        </>
      )}
    </ReportPage>
  );
}
