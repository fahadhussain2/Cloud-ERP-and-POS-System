import type {
  BillListRow,
  BillListView,
  ReturnListRow,
  ReturnListView,
  SalesChoicesView,
  SalesDocumentCustomer,
} from '@erp/contracts';
import { RETURN_REASONS } from '@erp/domain';
import { StatusChip } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { href } from '../router';
import { apiQuery, current, only, useFilters, type Filters } from './frame/filters';
import {
  ChoiceFilter,
  ListTable,
  moneyText,
  PeriodFilter,
  periodOf,
  periodQuery,
  periodWords,
  ReportPage,
  useReport,
  type ListColumn,
  type PeriodValue,
} from './frame/ReportFrame';
import { SearchFilter } from './ReportViews';

// Bills and Returns (W2-11 plan, D-126): the sales documents as lists on the report frame, under Sales in the menu.
// The owner's columns; every row opens the bill's details page (W2-10, D-125). They open on today, up to 92 days; the
// search (number, customer or walk-in phone) runs on the server, with the salesman and each list's own filters, all in
// the address. Strings are i18n keys (rule 10), money in the shop's format, CSS logical properties.

const s = (t: TFunction, key: string, o?: Record<string, unknown>) => t(`salesDocuments.${key}`, o ?? {});
const when = (at: string) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

const BILLS_QUERY = ['preset', 'from', 'to', 'q', 'salesmanId', 'method', 'status'];
const RETURNS_QUERY = ['preset', 'from', 'to', 'q', 'salesmanId', 'kind', 'reason'];

const BillLink = ({ number }: { number: string }) => (
  <a href={href.bill(number)} className="font-mono underline-offset-4 hover:underline">
    {number}
  </a>
);

function customerText(t: TFunction, c: SalesDocumentCustomer | null, phone: string | null) {
  if (c) return `${c.name} (${c.code})`;
  return phone ? s(t, 'walkInPhone', { phone }) : s(t, 'walkIn');
}

/** The filters and their address, shared by both lists. */
function useListFilters(name: string, keys: string[]) {
  const [filters, setFilters] = useFilters(name);
  const period = periodOf(filters, 'today');
  const query = only({ ...filters, ...periodQuery(period) }, keys);
  const set = (next: Filters) =>
    setFilters(only({ ...periodQuery(period), ...current(filters), ...next }, keys));
  const setPeriod = (p: PeriodValue) =>
    setFilters(only({ ...current(filters), from: '', to: '', preset: '', ...periodQuery(p) }, keys));
  return { filters, period, query, set, setPeriod };
}

function SalesmanFilter({
  api,
  value,
  onChange,
}: {
  api: Api;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const choices = useReport<SalesChoicesView>(api, '/api/reports/sales-choices').report;
  return (
    <ChoiceFilter
      label={s(t, 'filter.salesmanId')}
      value={value}
      options={[
        { value: '', label: s(t, 'any') },
        ...(choices?.salesmen ?? []).map((m) => ({ value: m.id, label: m.name })),
      ]}
      onChange={onChange}
    />
  );
}

export function BillsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const f = useListFilters('bills', BILLS_QUERY);
  const url = `/api/sales/bills?${apiQuery(f.query)}`;
  const { report, error } = useReport<BillListView>(api, url);
  // The shop's methods stay in the filter while the list reloads after a change.
  const [methods, setMethods] = useState<BillListView['methods']>([]);
  if (report && report.methods !== methods && report.methods.length > 0 && methods.length === 0)
    setMethods(report.methods);
  const m = report?.money;
  const columns: ListColumn<BillListRow>[] = m
    ? [
        {
          key: 'number',
          label: s(t, 'col.number'),
          sort: (r) => r.number,
          cell: (r) => <BillLink number={r.number} />,
        },
        { key: 'at', label: s(t, 'col.at'), sort: (r) => r.at, cell: (r) => when(r.at) },
        {
          key: 'customer',
          label: s(t, 'col.customer'),
          sort: (r) => customerText(t, r.customer, r.walkinPhone),
          cell: (r) => customerText(t, r.customer, r.walkinPhone),
        },
        {
          key: 'items',
          label: s(t, 'col.items'),
          end: true,
          sort: (r) => r.items,
          cell: (r) => String(r.items),
        },
        {
          key: 'total',
          label: s(t, 'col.total'),
          end: true,
          sort: (r) => r.total,
          cell: (r) => moneyText(r.total, m),
        },
        {
          key: 'paidBy',
          label: s(t, 'col.paidBy'),
          sort: (r) => r.paidBy.join(', '),
          cell: (r) => r.paidBy.join(', '),
        },
        {
          key: 'status',
          label: s(t, 'col.status'),
          sort: (r) => r.status,
          cell: (r) =>
            r.status === 'voided' ? (
              <StatusChip tone="bad">{s(t, 'voided', { number: r.voidNumber ?? '' })}</StatusChip>
            ) : (
              s(t, 'finalized')
            ),
        },
      ]
    : [];
  return (
    <ReportPage
      title={t('nav.bills')}
      help={s(t, 'help.bills')}
      filters={
        <>
          <PeriodFilter value={f.period} shown={report} onChange={f.setPeriod} />
          <SearchFilter label={s(t, 'search')} value={f.filters['q'] ?? ''} onChange={(q) => f.set({ q })} />
          <SalesmanFilter
            api={api}
            value={f.filters['salesmanId'] ?? ''}
            onChange={(v) => f.set({ salesmanId: v })}
          />
          <ChoiceFilter
            label={s(t, 'filter.method')}
            value={f.filters['method'] ?? ''}
            options={[
              { value: '', label: s(t, 'any') },
              ...methods.map((x) => ({ value: x.code, label: x.name })),
            ]}
            onChange={(v) => f.set({ method: v })}
          />
          <ChoiceFilter
            label={s(t, 'filter.status')}
            value={f.filters['status'] ?? ''}
            options={[
              { value: '', label: s(t, 'any') },
              { value: 'finalized', label: s(t, 'statuses.finalized') },
              { value: 'voided', label: s(t, 'statuses.voided') },
            ]}
            onChange={(v) => f.set({ status: v })}
          />
        </>
      }
      printFilters={[periodWords(report), f.filters['q'] ?? ''].filter(Boolean).join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'count', label: s(t, 'figures.bills'), value: String(report.total.count) },
              { key: 'total', label: s(t, 'figures.total'), value: moneyText(report.total.amount, m) },
            ]
          : []
      }
    >
      {report && m && (
        <>
          {report.truncated && <p className="m-0 text-sm text-muted-foreground">{s(t, 'truncated')}</p>}
          <ListTable
            label={t('nav.bills')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.id}
            text={(r) => `${r.number} ${customerText(t, r.customer, r.walkinPhone)}`}
          />
        </>
      )}
    </ReportPage>
  );
}

export function SalesReturnsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const f = useListFilters('returns', RETURNS_QUERY);
  const url = `/api/sales/returns?${apiQuery(f.query)}`;
  const { report, error } = useReport<ReturnListView>(api, url);
  const m = report?.money;
  const reasonText = (r: ReturnListRow) =>
    r.reason === 'several' ? s(t, 'several') : t(`billDetails.returnReasons.${r.reason}`);
  const refundText = (r: ReturnListRow) =>
    r.refund === 'paid'
      ? s(t, 'paidAt', { desk: r.refundDesk ?? '' })
      : r.refund === 'pending'
        ? s(t, 'notYet')
        : '—';
  const columns: ListColumn<ReturnListRow>[] = m
    ? [
        {
          key: 'number',
          label: s(t, 'col.returnNumber'),
          sort: (r) => r.number,
          cell: (r) => <BillLink number={r.number} />,
        },
        { key: 'at', label: s(t, 'col.at'), sort: (r) => r.at, cell: (r) => when(r.at) },
        { key: 'type', label: s(t, 'col.type'), sort: (r) => r.kind, cell: (r) => s(t, `kind.${r.kind}`) },
        {
          key: 'original',
          label: s(t, 'col.originalBill'),
          sort: (r) => r.originalBill ?? '',
          cell: (r) => (r.originalBill ? <BillLink number={r.originalBill} /> : s(t, 'noReceipt')),
        },
        {
          key: 'customer',
          label: s(t, 'col.customer'),
          sort: (r) => customerText(t, r.customer, r.walkinPhone),
          cell: (r) => customerText(t, r.customer, r.walkinPhone),
        },
        {
          key: 'itemsBack',
          label: s(t, 'col.itemsBack'),
          end: true,
          sort: (r) => r.itemsBack,
          cell: (r) => qtyText(r.itemsBack),
        },
        { key: 'reason', label: s(t, 'col.reason'), sort: reasonText, cell: reasonText },
        {
          key: 'refund',
          label: s(t, 'col.refund'),
          end: true,
          sort: (r) => r.total,
          cell: (r) => moneyText(r.total, m),
        },
        { key: 'refundPaid', label: s(t, 'col.refundPaid'), sort: refundText, cell: refundText },
        {
          key: 'status',
          label: s(t, 'col.status'),
          sort: (r) => r.status,
          cell: (r) =>
            r.status === 'voided' ? (
              <StatusChip tone="bad">{s(t, 'statuses.voided')}</StatusChip>
            ) : (
              s(t, 'finalized')
            ),
        },
      ]
    : [];
  return (
    <ReportPage
      title={t('nav.returns')}
      help={s(t, 'help.returns')}
      filters={
        <>
          <PeriodFilter value={f.period} shown={report} onChange={f.setPeriod} />
          <SearchFilter label={s(t, 'search')} value={f.filters['q'] ?? ''} onChange={(q) => f.set({ q })} />
          <SalesmanFilter
            api={api}
            value={f.filters['salesmanId'] ?? ''}
            onChange={(v) => f.set({ salesmanId: v })}
          />
          <ChoiceFilter
            label={s(t, 'filter.kind')}
            value={f.filters['kind'] ?? ''}
            options={[
              { value: '', label: s(t, 'any') },
              { value: 'return', label: s(t, 'kind.return') },
              { value: 'exchange', label: s(t, 'kind.exchange') },
            ]}
            onChange={(v) => f.set({ kind: v })}
          />
          <ChoiceFilter
            label={s(t, 'filter.reason')}
            value={f.filters['reason'] ?? ''}
            options={[
              { value: '', label: s(t, 'any') },
              ...RETURN_REASONS.map((r) => ({ value: r, label: t(`billDetails.returnReasons.${r}`) })),
            ]}
            onChange={(v) => f.set({ reason: v })}
          />
        </>
      }
      printFilters={[periodWords(report), f.filters['q'] ?? ''].filter(Boolean).join(' · ')}
      csv={report && `${url}&format=csv`}
      error={error}
      loading={report === null}
      figures={
        report && m
          ? [
              { key: 'count', label: s(t, 'figures.returns'), value: String(report.total.count) },
              { key: 'refunded', label: s(t, 'figures.refunded'), value: moneyText(report.total.amount, m) },
            ]
          : []
      }
    >
      {report && m && (
        <>
          {report.truncated && <p className="m-0 text-sm text-muted-foreground">{s(t, 'truncated')}</p>}
          <ListTable
            label={t('nav.returns')}
            columns={columns}
            rows={report.rows}
            rowKey={(r) => r.id}
            text={(r) => `${r.number} ${r.originalBill ?? ''} ${customerText(t, r.customer, r.walkinPhone)}`}
          />
        </>
      )}
    </ReportPage>
  );
}
