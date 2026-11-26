import type {
  AgeingPartyRow,
  AgeingView,
  BillTraceView,
  ExceptionRow,
  ExceptionsView,
  OverrideRow,
  OverridesView,
  RegisterRow,
  ReturnLineRow,
  SalesRegisterView,
  StockRow,
  StockView,
  VoidRow,
  VoidsReturnsView,
} from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  formatMoney,
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
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { href, navigate } from '../router';
import { useShopToday } from '../shopDay';
import { FormDialog } from '../staff/dialogs';
import { apiQuery, current, only, useFilters, type Filters } from './frame/filters';
import {
  ChoiceFilter,
  DateFilter,
  DaysFilter,
  ListTable,
  periodWords,
  ReportPage,
  useDays,
  useReport,
  type ListColumn,
} from './frame/ReportFrame';

// The W1-20 reports and support screens (RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12, D-110), the reports
// on the report frame since W2-04 (answer 8; D-116): filters in the address, key figures, sortable and searchable lists,
// Download CSV (owner answer 2) and the print layout. Read only, except an exception's review. Every figure is the
// API's, as before; values and costs come only when the API sends them (cost.view, owner answer 1).

type Money = SalesRegisterView['money'];

function Failed({ text }: { text: string | null }) {
  return text === null ? null : (
    <Alert variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

const Num = ({ children }: { children: ReactNode }) => (
  <TableCell className="text-end tabular-nums">{children}</TableCell>
);
const money = (v: number | null, m: Money) => (v === null ? '—' : formatMoney(v, m));
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---- On the report frame (W2-04 answer 8): the dates on the shop's business date, the totals, a bill's link ----

/** A small table of totals: a name and its figures (a count, an amount, a quantity). */
function Totals({
  title,
  columns,
  rows,
}: {
  title: string;
  /** The figures' headings. */
  columns: string[];
  rows: { key: string; label: string; cells: ReactNode[] }[];
}) {
  const { t } = useTranslation();
  return (
    <Panel className="min-w-64 flex-1 px-1.5 pb-1.5 break-inside-avoid">
      <Table aria-label={title}>
        <TableHeader>
          <TableRow>
            <TableHead>{title}</TableHead>
            {columns.map((c) => (
              <TableHead key={c} className="text-end">
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell>{r.label}</TableCell>
              {r.cells.map((c, i) => (
                <Num key={i}>{c}</Num>
              ))}
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns.length + 1} className="text-muted-foreground">
                {t('reports.none')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  );
}

/** A counter bill's number, opening its details (W2-10, D-125): every report reader may open a bill. */
function BillNumber({ number }: { number: string }) {
  return (
    <a href={href.bill(number)} className="underline-offset-4 hover:underline">
      {number}
    </a>
  );
}

// ---- Sales register (RPT-01, owner answer 3) ----

export function SalesRegisterScreen({ api }: { api: Api; permissions?: readonly string[] }) {
  const { t } = useTranslation();
  const days = useDays(api, 'salesRegister', []);
  const url = days.dates ? `/api/reports/sales-register?${apiQuery(days.dates)}` : null;
  const { report, error } = useReport<SalesRegisterView>(api, url);
  const m = report?.money;
  const columns: ListColumn<RegisterRow>[] = m
    ? [
        {
          key: 'number',
          label: t('reports.col.number'),
          sort: (b) => b.number,
          cell: (b) => {
            const voided = b.status === 'voided';
            return (
              <span className="font-mono">
                <span className={voided ? 'line-through' : undefined}>
                  <BillNumber number={b.number} />
                </span>
                {b.kind !== 'sale' && (
                  <span className="ms-2 inline-block">
                    <StatusChip tone="neutral">{t(`reports.kind.${b.kind}`)}</StatusChip>
                  </span>
                )}
                {voided && (
                  <span className="ms-2 inline-block">
                    <StatusChip tone="bad">
                      {t('reports.register.voidedAs', {
                        number: b.voidNumber ?? '',
                      })}
                    </StatusChip>
                  </span>
                )}
              </span>
            );
          },
        },
        {
          key: 'time',
          label: t('reports.col.time'),
          sort: (b) => b.createdAt,
          cell: (b) => `${b.businessDate} ${time(b.createdAt)}`,
        },
        {
          key: 'counter',
          label: t('reports.col.counter'),
          sort: (b) => b.deviceCode,
          cell: (b) => b.deviceCode,
        },
        {
          key: 'salesman',
          label: t('reports.col.salesman'),
          sort: (b) => b.salespersonName,
          cell: (b) => b.salespersonName,
        },
        {
          key: 'customer',
          label: t('reports.col.customer'),
          sort: (b) => b.customerName ?? '',
          cell: (b) => b.customerName ?? '—',
        },
        {
          key: 'tenders',
          label: t('reports.col.tenders'),
          cell: (b) => b.payments.map((p) => `${p.methodName} ${formatMoney(p.amount, m)}`).join(' · '),
        },
        {
          key: 'total',
          label: t('reports.col.total'),
          end: true,
          sort: (b) => b.total,
          cell: (b) => (
            <span className={b.status === 'voided' ? 'text-muted-foreground line-through' : undefined}>
              {formatMoney(b.total, m)}
            </span>
          ),
        },
      ]
    : [];
  return (
    <ReportPage
      title={t('reports.register.title')}
      help={t('reports.register.help')}
      filters={<DaysFilter days={days} />}
      printFilters={periodWords(days.dates)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              {
                key: 'bills',
                label: t('reports.register.bills'),
                value: report.totals.bills,
              },
              {
                key: 'total',
                label: t('reports.register.total'),
                value: formatMoney(report.totals.total, m),
              },
              {
                key: 'voided',
                label: t('reports.register.voided'),
                value: report.totals.voided,
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <ListTable
            label={t('reports.register.list')}
            columns={columns}
            rows={report.bills}
            rowKey={(b) => b.id}
            text={(b) =>
              [
                b.number,
                b.voidNumber ?? '',
                b.deviceCode,
                b.salespersonName,
                b.customerName ?? '',
                ...b.payments.map((p) => p.methodName),
              ].join(' ')
            }
          />
          <div className="flex flex-wrap gap-3">
            <Totals
              columns={[t('reports.register.bills'), t('reports.col.total')]}
              title={t('reports.register.bySalesman')}
              rows={report.totals.bySalesperson.map((x) => ({
                key: x.id,
                label: x.name,
                cells: [x.bills, formatMoney(x.total, m)],
              }))}
            />
            <Totals
              columns={[t('reports.register.bills'), t('reports.col.total')]}
              title={t('reports.register.byCounter')}
              rows={report.totals.byCounter.map((x) => ({
                key: x.code,
                label: x.code,
                cells: [x.bills, formatMoney(x.total, m)],
              }))}
            />
            <Totals
              columns={[t('reports.col.amount')]}
              title={t('reports.register.byTender')}
              rows={report.totals.byTender.map((x) => ({
                key: x.code,
                label: x.name,
                cells: [formatMoney(x.amount, m)],
              }))}
            />
          </div>
        </>
      )}
    </ReportPage>
  );
}

// ---- Overrides (RPT-03) ----

export function OverridesScreen({ api }: { api: Api; permissions?: readonly string[] }) {
  const { t } = useTranslation();
  const days = useDays(api, 'overridesReport', []);
  const url = days.dates ? `/api/reports/overrides?${apiQuery(days.dates)}` : null;
  const { report, error } = useReport<OverridesView>(api, url);
  const m = report?.money;
  const columns: ListColumn<OverrideRow>[] = m
    ? [
        {
          key: 'time',
          label: t('reports.col.time'),
          sort: (o) => o.at,
          cell: (o) => `${o.businessDate} ${time(o.at)}`,
        },
        {
          key: 'kind',
          label: t('reports.col.kind'),
          sort: (o) => kindName(t, o.kind),
          cell: (o) => kindName(t, o.kind),
        },
        {
          key: 'number',
          label: t('reports.col.number'),
          sort: (o) => o.billNumber,
          cell: (o) => (
            <span className="font-mono">
              <BillNumber number={o.billNumber} />
            </span>
          ),
        },
        {
          key: 'item',
          label: t('reports.col.item'),
          sort: (o) => o.itemCode ?? '',
          cell: (o) => (o.itemCode ? `${o.itemCode} ${o.itemName ?? ''}` : '—'),
        },
        {
          key: 'askedBy',
          label: t('reports.ovr.askedBy'),
          sort: (o) => o.requestedByName,
          cell: (o) => o.requestedByName,
        },
        {
          key: 'approvedBy',
          label: t('reports.ovr.approvedBy'),
          sort: (o) => o.approvedByName,
          cell: (o) => o.approvedByName,
        },
        {
          key: 'reason',
          label: t('reports.col.reason'),
          sort: (o) => o.reasonCode,
          cell: (o) => (o.note ? `${o.reasonCode}: ${o.note}` : o.reasonCode),
        },
        {
          key: 'list',
          label: t('reports.ovr.list_'),
          end: true,
          sort: (o) => o.listPrice ?? -Infinity,
          cell: (o) => money(o.listPrice, m),
        },
        {
          key: 'price',
          label: t('reports.ovr.price'),
          end: true,
          sort: (o) => o.unitPrice ?? -Infinity,
          cell: (o) => money(o.unitPrice, m),
        },
        {
          key: 'floor',
          label: t('reports.ovr.floor'),
          end: true,
          sort: (o) => o.floorPrice ?? -Infinity,
          cell: (o) => money(o.floorPrice, m),
        },
      ]
    : [];
  return (
    <ReportPage
      title={t('reports.ovr.title')}
      help={t('reports.ovr.help')}
      filters={<DaysFilter days={days} />}
      printFilters={periodWords(days.dates)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={report ? [{ key: 'count', label: t('reports.ovr.list'), value: report.overrides.length }] : []}
    >
      {report && m && (
        <>
          <ListTable
            label={t('reports.ovr.list')}
            columns={columns}
            rows={report.overrides}
            rowKey={(o) => o.id}
            text={(o) =>
              [
                o.billNumber,
                kindName(t, o.kind),
                o.itemCode ?? '',
                o.itemName ?? '',
                o.requestedByName,
                o.approvedByName,
                o.reasonCode,
                o.note ?? '',
              ].join(' ')
            }
          />
          <div className="flex flex-wrap gap-3">
            <Totals
              columns={[t('reports.ovr.list')]}
              title={t('reports.ovr.byRequester')}
              rows={report.byRequester.map((x) => ({ key: x.name, label: x.name, cells: [x.count] }))}
            />
            <Totals
              columns={[t('reports.ovr.list')]}
              title={t('reports.ovr.byApprover')}
              rows={report.byApprover.map((x) => ({ key: x.name, label: x.name, cells: [x.count] }))}
            />
            <Totals
              columns={[t('reports.ovr.list')]}
              title={t('reports.ovr.byKind')}
              rows={report.byKind.map((x) => ({ key: x.kind, label: kindName(t, x.kind), cells: [x.count] }))}
            />
          </div>
        </>
      )}
    </ReportPage>
  );
}

const kindName = (t: TFunction, kind: string) => t(`reports.ovr.kinds.${kind}`, { defaultValue: kind });

// ---- Voids and returns (RPT-04) ----

export function VoidsReturnsScreen({ api }: { api: Api; permissions?: readonly string[] }) {
  const { t } = useTranslation();
  const days = useDays(api, 'voidsReturns', []);
  const url = days.dates ? `/api/reports/voids-returns?${apiQuery(days.dates)}` : null;
  const { report, error } = useReport<VoidsReturnsView>(api, url);
  const m = report?.money;
  const bill = (number: string) => (
    <span className="font-mono">
      <BillNumber number={number} />
    </span>
  );
  const voidColumns: ListColumn<VoidRow>[] = m
    ? [
        {
          key: 'time',
          label: t('reports.col.time'),
          sort: (v) => v.at,
          cell: (v) => `${v.businessDate} ${time(v.at)}`,
        },
        { key: 'number', label: t('reports.col.number'), sort: (v) => v.number, cell: (v) => bill(v.number) },
        {
          key: 'bill',
          label: t('reports.vr.bill'),
          sort: (v) => v.saleNumber,
          cell: (v) => bill(v.saleNumber),
        },
        {
          key: 'reason',
          label: t('reports.col.reason'),
          sort: (v) => v.reasonCode,
          cell: (v) => (v.note ? `${v.reasonCode}: ${v.note}` : v.reasonCode),
        },
        {
          key: 'voidedBy',
          label: t('reports.vr.voidedBy'),
          sort: (v) => v.voidedByName,
          cell: (v) => v.voidedByName,
        },
        {
          key: 'approvedBy',
          label: t('reports.ovr.approvedBy'),
          sort: (v) => v.approvedByName,
          cell: (v) => v.approvedByName,
        },
        {
          key: 'reissue',
          label: t('reports.vr.reissue'),
          sort: (v) => v.reissueNumber ?? '',
          cell: (v) => (v.reissueNumber ? bill(v.reissueNumber) : '—'),
        },
        {
          key: 'total',
          label: t('reports.col.total'),
          end: true,
          sort: (v) => v.saleTotal ?? -Infinity,
          cell: (v) => money(v.saleTotal, m),
        },
      ]
    : [];
  const returnColumns: ListColumn<ReturnLineRow & { n: number }>[] = m
    ? [
        {
          key: 'date',
          label: t('reports.col.date'),
          sort: (x) => x.businessDate,
          cell: (x) => x.businessDate,
        },
        {
          key: 'number',
          label: t('reports.col.number'),
          sort: (x) => x.billNumber,
          cell: (x) => bill(x.billNumber),
        },
        {
          key: 'salesman',
          label: t('reports.col.salesman'),
          sort: (x) => x.salespersonName,
          cell: (x) => x.salespersonName,
        },
        {
          key: 'item',
          label: t('reports.col.item'),
          sort: (x) => x.itemCode,
          cell: (x) => `${x.itemCode} ${x.itemName}`,
        },
        {
          key: 'qty',
          label: t('reports.col.qty'),
          end: true,
          sort: (x) => x.qty,
          cell: (x) => qtyText(x.qty),
        },
        {
          key: 'reason',
          label: t('reports.col.reason'),
          sort: (x) => x.reasonCode,
          cell: (x) => x.reasonCode,
        },
        {
          key: 'condition',
          label: t('reports.vr.conditionTitle'),
          sort: (x) => x.condition,
          cell: (x) => t(`reports.vr.condition.${x.condition}`),
        },
        {
          key: 'original',
          label: t('reports.vr.original'),
          sort: (x) => x.originalBillNumber ?? '',
          cell: (x) => (x.originalBillNumber ? bill(x.originalBillNumber) : t('reports.vr.noReceipt')),
        },
        {
          key: 'amount',
          label: t('reports.col.amount'),
          end: true,
          sort: (x) => x.amount,
          cell: (x) => formatMoney(x.amount, m),
        },
      ]
    : [];
  return (
    <ReportPage
      title={t('reports.vr.title')}
      help={t('reports.vr.help')}
      filters={<DaysFilter days={days} />}
      printFilters={periodWords(days.dates)}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report
          ? [
              { key: 'voids', label: t('reports.vr.voids'), value: report.voids.length },
              { key: 'returns', label: t('reports.vr.returns'), value: report.returns.length },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <div className="flex flex-wrap gap-3">
            <Totals
              columns={[t('reports.vr.voids')]}
              title={t('reports.vr.voidsByReason')}
              rows={report.voidsByReason.map((x) => ({ key: x.reason, label: x.reason, cells: [x.count] }))}
            />
            <Totals
              columns={[t('reports.vr.returns'), t('reports.col.amount')]}
              title={t('reports.vr.returnsByReason')}
              rows={report.returnsByReason.map((x) => ({
                key: x.reason,
                label: x.reason,
                cells: [x.count, formatMoney(x.amount, m)],
              }))}
            />
            <Totals
              columns={[t('reports.vr.returns'), t('reports.col.amount')]}
              title={t('reports.vr.returnsByCondition')}
              rows={report.returnsByCondition.map((x) => ({
                key: x.condition,
                label: t(`reports.vr.condition.${x.condition}`),
                cells: [x.count, formatMoney(x.amount, m)],
              }))}
            />
          </div>
          <h2 className="m-0 text-base font-semibold">{t('reports.vr.voids')}</h2>
          <ListTable
            label={t('reports.vr.voids')}
            columns={voidColumns}
            rows={report.voids}
            rowKey={(v) => v.number}
            text={(v) =>
              [
                v.number,
                v.saleNumber,
                v.reissueNumber ?? '',
                v.reasonCode,
                v.note ?? '',
                v.voidedByName,
                v.approvedByName,
              ].join(' ')
            }
          />
          <h2 className="m-0 text-base font-semibold">{t('reports.vr.returns')}</h2>
          <ListTable
            label={t('reports.vr.returns')}
            columns={returnColumns}
            // A bill can return the same item twice: each line keeps its place.
            rows={report.returns.map((x, n) => ({ ...x, n }))}
            rowKey={(x) => String(x.n)}
            text={(x) =>
              [
                x.billNumber,
                x.originalBillNumber ?? '',
                x.salespersonName,
                x.itemCode,
                x.itemName,
                x.reasonCode,
              ].join(' ')
            }
          />
        </>
      )}
    </ReportPage>
  );
}

// ---- Stock and valuation (RPT-05, owner answer 7) ----

/**
 * A text the server searches (beyond the lines a list can hold): typed here, put in the address once typing stops,
 * and back to the address's on Back.
 */
function SearchFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    if (text.trim() === value) return;
    const id = setTimeout(() => latest.current(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text, value]);
  return (
    <TextField
      type="search"
      label={label}
      value={text}
      wrapperClassName="gap-1"
      className="h-9 w-64"
      onChange={(e) => setText(e.target.value)}
    />
  );
}

export function StockReportScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('stockReport');
  const text = filters['q'] ?? '';
  const below = filters['below'] === '1';
  const url = `/api/reports/stock?${apiQuery({ q: text, ...(below ? { below: '1' } : {}) })}`;
  const { report, error } = useReport<StockView>(api, url);
  const m = report?.money;
  const set = (next: Filters) => setFilters(only({ ...current(filters), ...next }, ['q', 'below']));
  const values = report?.values === true;
  const columns: ListColumn<StockRow>[] = m
    ? [
        {
          key: 'item',
          label: t('reports.col.item'),
          sort: (x) => x.itemCode,
          cell: (x) => (
            <a href={href.stockCard(x.itemId)} className="underline-offset-4 hover:underline">
              <span className="font-mono">{x.itemCode}</span> {x.itemName}
            </a>
          ),
        },
        {
          key: 'category',
          label: t('reports.stock.category'),
          sort: (x) => x.categoryName ?? '',
          cell: (x) => x.categoryName ?? '—',
        },
        {
          key: 'location',
          label: t('reports.stock.location'),
          sort: (x) => x.locationCode,
          cell: (x) => x.locationCode,
        },
        {
          key: 'qty',
          label: t('reports.col.qty'),
          end: true,
          sort: (x) => x.qty,
          cell: (x) => <span className={x.qty < 0 ? 'text-bad' : undefined}>{qtyText(x.qty)}</span>,
        },
        ...(values
          ? [
              {
                key: 'avgCost',
                label: t('reports.stock.avgCost'),
                end: true,
                sort: (x: StockRow) => x.avgCost ?? -Infinity,
                cell: (x: StockRow) =>
                  x.avgCost === null ? t('reports.stock.noCostShort') : money(x.avgCost, m),
              },
              {
                key: 'value',
                label: t('reports.stock.value'),
                end: true,
                sort: (x: StockRow) => x.value ?? -Infinity,
                cell: (x: StockRow) => money(x.value, m),
              },
            ]
          : []),
      ]
    : [];
  const breakdown = (rows: { key: string; label: string; qty: number; value: number | null }[]) =>
    rows.map((x) => ({
      key: x.key,
      label: x.label,
      cells: [qtyText(x.qty), ...(values && m ? [money(x.value, m)] : [])],
    }));
  const headings = [t('reports.stock.onHand'), ...(values ? [t('reports.stock.value')] : [])];
  return (
    <ReportPage
      title={t('reports.stock.title')}
      help={t('reports.stock.help')}
      filters={
        <>
          <SearchFilter label={t('reports.stock.search')} value={text} onChange={(v) => set({ q: v })} />
          <div className="flex h-9 items-center gap-2">
            <Checkbox
              id="stock-below"
              checked={below}
              onCheckedChange={(c) => set({ below: c === true ? '1' : '' })}
            />
            <Label htmlFor="stock-below">{t('reports.stock.below')}</Label>
          </div>
        </>
      }
      printFilters={[text, below ? t('reports.stock.below') : ''].filter(Boolean).join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              { key: 'qty', label: t('reports.stock.onHand'), value: qtyText(report.total.qty) },
              ...(values
                ? [{ key: 'value', label: t('reports.stock.value'), value: money(report.total.value, m) }]
                : []),
            ]
          : []
      }
    >
      {report && m && (
        <>
          {report.noCost > 0 && (
            <p className="m-0 text-sm text-warn">{t('reports.stock.noCost', { count: report.noCost })}</p>
          )}
          {report.truncated && (
            <p className="m-0 text-sm text-muted-foreground">{t('reports.stock.truncated')}</p>
          )}
          <ListTable
            label={t('reports.stock.list')}
            columns={columns}
            rows={report.rows}
            rowKey={(x) => `${x.itemId}-${x.locationCode}`}
            text={(x) => `${x.itemCode} ${x.itemName} ${x.categoryName ?? ''} ${x.locationCode}`}
          />
          <div className="flex flex-wrap gap-3">
            <Totals
              title={t('reports.stock.byLocation')}
              columns={headings}
              rows={breakdown(report.byLocation.map((x) => ({ ...x, key: x.code, label: x.name })))}
            />
            <Totals
              title={t('reports.stock.byCategory')}
              columns={headings}
              rows={breakdown(report.byCategory.map((x) => ({ ...x, key: x.name, label: x.name || '—' })))}
            />
          </div>
        </>
      )}
    </ReportPage>
  );
}

// ---- Outstanding and ageing (RPT-06, owner answer 4) ----

const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
const SIDES = ['customers', 'suppliers'] as const;

export function AgeingScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  // As on the shop's business date (D-117) until another date is picked; that date isn't remembered.
  const [filters, setFilters] = useFilters('ageing', { forget: ['asOf'] });
  const today = useShopToday(api);
  const side = filters['side'] === 'suppliers' ? 'suppliers' : 'customers';
  const asOf = filters['asOf'] || today || '';
  const url = asOf ? `/api/reports/ageing?${apiQuery({ side, asOf })}` : null;
  const { report, error } = useReport<AgeingView>(api, url);
  const m = report?.money;
  const set = (next: Filters) => setFilters(only({ ...current(filters), ...next }, ['side', 'asOf']));
  const matches = report !== null && report.controlBalance === report.totals.balance;
  const columns: ListColumn<AgeingPartyRow>[] = m
    ? [
        {
          key: 'party',
          label: t('reports.ageing.party'),
          sort: (x) => x.name,
          cell: (x) => (
            <>
              <span className="font-mono">{x.code}</span> {x.name}
            </>
          ),
        },
        {
          key: 'terms',
          label: t('reports.ageing.terms'),
          end: true,
          sort: (x) => x.termsDays ?? -1,
          cell: (x) => (x.termsDays === null ? '—' : t('reports.ageing.days', { count: x.termsDays })),
        },
        ...BUCKETS.map((b) => ({
          key: b,
          label: t(`reports.ageing.buckets.${b}`),
          end: true,
          sort: (x: AgeingPartyRow) => x[b],
          cell: (x: AgeingPartyRow) => (
            <span className={b === 'over90' && x[b] > 0 ? 'text-bad' : undefined}>
              {x[b] === 0 ? '' : formatMoney(x[b], m)}
            </span>
          ),
        })),
        {
          key: 'balance',
          label: t('reports.ageing.balance'),
          end: true,
          sort: (x) => x.balance,
          cell: (x) => <span className="font-semibold">{formatMoney(x.balance, m)}</span>,
        },
      ]
    : [];
  return (
    <ReportPage
      title={t('reports.ageing.title')}
      help={t('reports.ageing.help')}
      filters={
        <>
          <ChoiceFilter
            label={t('reports.ageing.side')}
            value={side}
            options={SIDES.map((s) => ({ value: s, label: t(`reports.ageing.${s}`) }))}
            onChange={(v) => set({ side: v })}
          />
          <DateFilter label={t('reports.ageing.asOf')} value={asOf} onChange={(v) => set({ asOf: v })} />
        </>
      }
      printFilters={`${t(`reports.ageing.${side}`)} · ${asOf}`}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report && m
          ? [
              {
                key: 'balance',
                label: t('reports.ageing.balance'),
                value: formatMoney(report.totals.balance, m),
              },
              {
                key: 'over90',
                label: t('reports.ageing.buckets.over90'),
                value: formatMoney(report.totals.over90, m),
                ...(report.totals.over90 > 0 ? { tone: 'bad' as const } : {}),
              },
              {
                key: 'control',
                label: t(`reports.ageing.control.${report.side}`),
                value: formatMoney(report.controlBalance, m),
                ...(matches ? {} : { tone: 'bad' as const }),
              },
            ]
          : []
      }
    >
      {report && m && (
        <>
          <ListTable
            label={t(`reports.ageing.${report.side}`)}
            columns={columns}
            rows={report.rows}
            rowKey={(x) => x.partyId}
            text={(x) => `${x.code} ${x.name}`}
            footer={[
              t('reports.ageing.total'),
              '',
              ...BUCKETS.map((b) => formatMoney(report.totals[b], m)),
              formatMoney(report.totals.balance, m),
            ]}
          />
          <p className={`m-0 text-sm ${matches ? 'text-muted-foreground' : 'text-bad'}`}>
            {t(matches ? 'reports.ageing.matches' : 'reports.ageing.differs', {
              account: t(`reports.ageing.control.${report.side}`),
              amount: formatMoney(report.controlBalance, m),
            })}
          </p>
        </>
      )}
    </ReportPage>
  );
}

// ---- Exceptions (RPT-10, owner answer 5) ----

const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const;
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export function ExceptionsScreen({ api, permissions }: { api: Api; permissions: readonly string[] }) {
  const { t } = useTranslation();
  const days = useDays(api, 'exceptions', ['status']);
  const all = days.filters['status'] === 'all';
  const [version, setVersion] = useState(0);
  const [reviewing, setReviewing] = useState<ExceptionRow | null>(null);
  const url = days.dates
    ? `/api/reports/exceptions?${apiQuery({ ...days.dates, ...(all ? {} : { status: 'open' }) })}`
    : null;
  const { report, error } = useReport<ExceptionsView>(api, url, version);
  const canReview = permissions.includes('exceptions.review');
  const kindOf = (e: ExceptionRow) => t(`reports.exc.kinds.${e.kind}`, { defaultValue: e.kind });
  const columns: ListColumn<ExceptionRow>[] = [
    {
      key: 'date',
      label: t('reports.col.date'),
      sort: (e) => e.createdAt,
      cell: (e) => `${e.businessDate} ${time(e.createdAt)}`,
    },
    { key: 'kind', label: t('reports.exc.kind'), sort: kindOf, cell: kindOf },
    {
      key: 'severity',
      label: t('reports.exc.severity'),
      sort: (e) => SEVERITY_ORDER[e.severity],
      cell: (e) => (
        <StatusChip tone={SEVERITY_TONE[e.severity]}>{t(`reports.exc.severities.${e.severity}`)}</StatusChip>
      ),
    },
    {
      key: 'counter',
      label: t('reports.col.counter'),
      sort: (e) => e.deviceCode ?? '',
      cell: (e) => e.deviceCode ?? '—',
    },
    {
      key: 'document',
      label: t('reports.exc.document'),
      sort: (e) => e.documentNumber ?? '',
      cell: (e) => (
        <span className="font-mono">{e.documentNumber ? <BillNumber number={e.documentNumber} /> : '—'}</span>
      ),
    },
    {
      key: 'status',
      label: t('reports.exc.status'),
      sort: (e) => e.status,
      cell: (e) => (
        <>
          {t(`reports.exc.statuses.${e.status}`)}
          {e.reviewedByName && (
            <span className="block text-sm text-muted-foreground">
              {e.reviewedByName}
              {e.reviewNote ? `: ${e.reviewNote}` : ''}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'review',
      label: '',
      cell: (e) =>
        canReview && (
          <Button size="sm" variant="outline" className="print:hidden" onClick={() => setReviewing(e)}>
            {t('reports.exc.review')}
          </Button>
        ),
    },
  ];
  return (
    <ReportPage
      title={t('reports.exc.title')}
      help={t('reports.exc.help')}
      filters={
        <>
          <DaysFilter days={days} />
          <div className="flex h-9 items-center gap-2">
            <Checkbox
              id="exceptions-all"
              checked={all}
              onCheckedChange={(c) => days.set({ status: c === true ? 'all' : '' })}
            />
            <Label htmlFor="exceptions-all">{t('reports.exc.showReviewed')}</Label>
          </div>
        </>
      }
      printFilters={[periodWords(days.dates), all ? t('reports.exc.showReviewed') : '']
        .filter(Boolean)
        .join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null && error === null}
      figures={
        report ? [{ key: 'count', label: t('reports.exc.list'), value: report.exceptions.length }] : []
      }
    >
      {report && (
        <ListTable
          label={t('reports.exc.list')}
          columns={columns}
          rows={report.exceptions}
          rowKey={(e) => e.id}
          text={(e) =>
            [
              kindOf(e),
              e.deviceCode ?? '',
              e.documentNumber ?? '',
              e.reviewedByName ?? '',
              e.reviewNote ?? '',
            ].join(' ')
          }
          empty={t('reports.exc.none')}
        />
      )}
      {reviewing && (
        <ReviewDialog
          api={api}
          exception={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </ReportPage>
  );
}

function ReviewDialog({
  api,
  exception,
  onClose,
  onDone,
}: {
  api: Api;
  exception: ExceptionRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'reviewed' | 'dismissed' | 'open'>(
    exception.status === 'open' ? 'reviewed' : 'open',
  );
  const [note, setNote] = useState(exception.reviewNote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    const r = await api('POST', `/api/reports/exceptions/${encodeURIComponent(exception.id)}/review`, {
      status,
      note: note.trim() === '' ? null : note.trim(),
    });
    setBusy(false);
    if (r.status === 200) return onDone();
    setError(t('reports.failed'));
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('reports.exc.reviewTitle')}
      description={t(`reports.exc.kinds.${exception.kind}`, { defaultValue: exception.kind })}
      actionLabel={t('reports.exc.save')}
      cancelLabel={t('reports.exc.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className={LABEL_CLASS}>{t('reports.exc.status')}</legend>
        {(['reviewed', 'dismissed', 'open'] as const).map((s) => (
          <label key={s} className="flex items-center gap-2">
            <input
              type="radio"
              name="exception-status"
              checked={status === s}
              onChange={() => setStatus(s)}
            />
            {t(`reports.exc.statuses.${s}`)}
          </label>
        ))}
      </fieldset>
      {status !== 'open' && (
        <TextField
          label={t('reports.exc.note')}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <pre className="m-0 overflow-x-auto rounded-md bg-surface-2 p-2 text-xs">
        {JSON.stringify(exception.details, null, 2)}
      </pre>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormDialog>
  );
}

// ---- Trace a bill (PLT-12) ----

export function TraceScreen({ api, number }: { api: Api; number: string | null }) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState(number ?? '');
  const url = number ? `/api/support/bills/${encodeURIComponent(number)}` : null;
  const [state, setState] = useState<{ url: string | null; trace: BillTraceView | null; missing: boolean }>({
    url: null,
    trace: null,
    missing: false,
  });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void api('GET', url).then((r) => {
      if (live)
        setState({
          url,
          trace: r.status === 200 ? (r.body as BillTraceView) : null,
          missing: r.status !== 200,
        });
    });
    return () => {
      live = false;
    };
  }, [api, url]);
  const trace = state.url === url ? state.trace : null;
  const missing = state.url === url && state.missing;
  return (
    <>
      <PageHeader title={t('support.trace.title')} help={t('support.trace.help')} />
      <Panel className="p-3.5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) navigate(href.trace(typed.trim()));
          }}
        >
          <TextField
            label={t('support.trace.number')}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button type="submit">{t('support.trace.find')}</Button>
        </form>
      </Panel>
      {missing && <Failed text={t('support.trace.notFound', { number: number ?? '' })} />}
      {trace && (
        <>
          <Panel className="flex flex-wrap gap-6 p-3.5">
            <a
              href={href.bill(trace.bill.number)}
              className="font-mono text-lg font-semibold underline-offset-4 hover:underline"
            >
              {trace.bill.number}
            </a>
            <span>{t(`reports.kind.${trace.bill.kind}`)}</span>
            <span>{trace.bill.businessDate}</span>
            <span>{trace.bill.deviceCode}</span>
            <span>{trace.bill.salespersonName}</span>
            <span className="tabular-nums">{formatMoney(trace.bill.total, trace.money)}</span>
            {trace.bill.status === 'voided' && (
              <StatusChip tone="bad">{t('support.trace.voided')}</StatusChip>
            )}
          </Panel>
          <Panel title={t('support.trace.timeline')} className="pb-2">
            <ol className="m-0 flex list-none flex-col gap-2 px-3.5 py-1">
              {trace.steps.map((s, i) => (
                <li key={i} className="grid grid-cols-1 gap-x-3 sm:grid-cols-[11rem_7rem_1fr]">
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {new Date(s.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' })}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`support.trace.sources.${s.source}`)}
                  </span>
                  <span>
                    {t(`support.trace.steps.${s.step}`, {
                      ...s.detail,
                      amount:
                        typeof s.detail['amount'] === 'number'
                          ? formatMoney(s.detail['amount'], trace.money)
                          : '',
                      total:
                        typeof s.detail['total'] === 'number'
                          ? formatMoney(s.detail['total'], trace.money)
                          : '',
                      defaultValue: `${s.step} ${Object.values(s.detail)
                        .filter((v) => v !== null)
                        .join(' ')}`,
                    })}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </>
      )}
    </>
  );
}
