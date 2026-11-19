import type {
  AgeingView,
  BillTraceView,
  ExceptionRow,
  ExceptionsView,
  OverridesView,
  SalesRegisterView,
  StockView,
  VoidsReturnsView,
} from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  formatMoney,
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
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { href, navigate } from '../router';
import { DateField } from '../screens/ReportsScreens';
import { useShopToday } from '../shopDay';
import { FormDialog } from '../staff/dialogs';

// The W1-20 reports and support screens (RPT-01, RPT-03, RPT-04, RPT-05, RPT-06, RPT-10, PLT-12, D-110): filters at
// the top, totals, then the list, and Download CSV (owner answer 2). Read only, except an exception's review. Values
// and costs come only when the API sends them (cost.view, owner answer 1).

type Money = SalesRegisterView['money'];

/** Fetches a report whenever its address changes; null while loading or after a refusal (with the words for it). */
function useReport<T>(api: Api, url: string | null, version = 0): { report: T | null; error: string | null } {
  const { t } = useTranslation();
  const [state, setState] = useState<{ url: string | null; report: T | null; error: string | null }>({
    url: null,
    report: null,
    error: null,
  });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void api('GET', url).then((r) => {
      if (!live) return;
      const error = (r.body as { error?: string } | null)?.error;
      setState(
        r.status === 200
          ? { url, report: r.body as T, error: null }
          : {
              url,
              report: null,
              error: error === 'range_too_long' ? t('reports.range.tooLong') : t('reports.failed'),
            },
      );
    });
    return () => {
      live = false;
    };
  }, [api, url, version, t]);
  return state.url === url ? { report: state.report, error: state.error } : { report: null, error: null };
}

function Range({
  from,
  to,
  onFrom,
  onTo,
  csv,
  children,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  csv: string | null;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Panel className="flex flex-wrap items-end gap-4 p-3.5">
      <DateField label={t('reports.range.from')} value={from} onChange={onFrom} />
      <DateField label={t('reports.range.to')} value={to} onChange={onTo} />
      {children}
      {csv && (
        <Button asChild variant="outline">
          <a href={csv}>{t('reports.csv')}</a>
        </Button>
      )}
    </Panel>
  );
}

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

/** A small table of totals: a name, a count, an amount. */
function Totals({
  title,
  rows,
  m,
}: {
  title: string;
  rows: { key: string; label: string; count?: number; amount: number | null }[];
  m: Money;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={title} className="pb-2">
      {rows.length === 0 ? (
        <p className="m-0 px-3.5 text-muted-foreground">{t('reports.none')}</p>
      ) : (
        <Table aria-label={title}>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>{r.label}</TableCell>
                {r.count !== undefined && <Num>{r.count}</Num>}
                <Num>{money(r.amount, m)}</Num>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** From and to: the shop's business date (W2-05) until other dates are picked. */
const useRange = (api: Api) => {
  const today = useShopToday(api) ?? '';
  const [pickedFrom, setFrom] = useState<string | null>(null);
  const [pickedTo, setTo] = useState<string | null>(null);
  const from = pickedFrom ?? today;
  const to = pickedTo ?? today;
  return { from, to, setFrom, setTo, query: `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` };
};

// ---- Sales register (RPT-01, owner answer 3) ----

export function SalesRegisterScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const r = useRange(api);
  const url = r.from && r.to ? `/api/reports/sales-register?${r.query}` : null;
  const { report, error } = useReport<SalesRegisterView>(api, url);
  return (
    <>
      <PageHeader title={t('reports.register.title')} help={t('reports.register.help')} />
      <Range from={r.from} to={r.to} onFrom={r.setFrom} onTo={r.setTo} csv={report && `${url}&format=csv`} />
      <Failed text={error} />
      {report && (
        <>
          <Panel className="flex flex-wrap gap-6 p-3.5">
            <span>
              <span className={LABEL_CLASS}>{t('reports.register.bills')}</span>{' '}
              <span className="font-semibold tabular-nums">{report.totals.bills}</span>
            </span>
            <span>
              <span className={LABEL_CLASS}>{t('reports.register.total')}</span>{' '}
              <span className="font-semibold tabular-nums">
                {formatMoney(report.totals.total, report.money)}
              </span>
            </span>
            <span>
              <span className={LABEL_CLASS}>{t('reports.register.voided')}</span>{' '}
              <span className="font-semibold tabular-nums">{report.totals.voided}</span>
            </span>
          </Panel>
          <div className="grid gap-2.5 lg:grid-cols-3">
            <Totals
              title={t('reports.register.bySalesman')}
              m={report.money}
              rows={report.totals.bySalesperson.map((s) => ({
                key: s.id,
                label: s.name,
                count: s.bills,
                amount: s.total,
              }))}
            />
            <Totals
              title={t('reports.register.byCounter')}
              m={report.money}
              rows={report.totals.byCounter.map((c) => ({
                key: c.code,
                label: c.code,
                count: c.bills,
                amount: c.total,
              }))}
            />
            <Totals
              title={t('reports.register.byTender')}
              m={report.money}
              rows={report.totals.byTender.map((p) => ({ key: p.code, label: p.name, amount: p.amount }))}
            />
          </div>
          <Panel title={t('reports.register.list')} className="overflow-x-auto">
            <Table aria-label={t('reports.register.list')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports.col.number')}</TableHead>
                  <TableHead>{t('reports.col.time')}</TableHead>
                  <TableHead>{t('reports.col.counter')}</TableHead>
                  <TableHead>{t('reports.col.salesman')}</TableHead>
                  <TableHead>{t('reports.col.customer')}</TableHead>
                  <TableHead>{t('reports.col.tenders')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.bills.map((b) => {
                  const voided = b.status === 'voided';
                  return (
                    <TableRow key={b.id} className={voided ? 'text-muted-foreground' : undefined}>
                      <TableCell className="font-mono">
                        <span className={voided ? 'line-through' : undefined}>{b.number}</span>
                        {b.kind !== 'sale' && (
                          <span className="ms-2 inline-block">
                            <StatusChip tone="neutral">{t(`reports.kind.${b.kind}`)}</StatusChip>
                          </span>
                        )}
                        {voided && (
                          <span className="ms-2 inline-block">
                            <StatusChip tone="bad">
                              {t('reports.register.voidedAs', { number: b.voidNumber ?? '' })}
                            </StatusChip>
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {b.businessDate} {time(b.createdAt)}
                      </TableCell>
                      <TableCell>{b.deviceCode}</TableCell>
                      <TableCell>{b.salespersonName}</TableCell>
                      <TableCell>{b.customerName ?? '—'}</TableCell>
                      <TableCell>
                        {b.payments
                          .map((p) => `${p.methodName} ${formatMoney(p.amount, report.money)}`)
                          .join(' · ')}
                      </TableCell>
                      <TableCell className={`text-end tabular-nums ${voided ? 'line-through' : ''}`}>
                        {formatMoney(b.total, report.money)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {report.bills.length === 0 && (
              <p className="m-0 p-3.5 text-muted-foreground">{t('reports.none')}</p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

// ---- Overrides (RPT-03) ----

export function OverridesScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const r = useRange(api);
  const url = r.from && r.to ? `/api/reports/overrides?${r.query}` : null;
  const { report, error } = useReport<OverridesView>(api, url);
  return (
    <>
      <PageHeader title={t('reports.ovr.title')} help={t('reports.ovr.help')} />
      <Range from={r.from} to={r.to} onFrom={r.setFrom} onTo={r.setTo} csv={report && `${url}&format=csv`} />
      <Failed text={error} />
      {report && (
        <>
          <div className="grid gap-2.5 lg:grid-cols-3">
            {(
              [
                [
                  'byRequester',
                  report.byRequester.map((x) => ({ key: x.name, label: x.name, count: x.count })),
                ],
                [
                  'byApprover',
                  report.byApprover.map((x) => ({ key: x.name, label: x.name, count: x.count })),
                ],
                [
                  'byKind',
                  report.byKind.map((x) => ({ key: x.kind, label: kindName(t, x.kind), count: x.count })),
                ],
              ] as const
            ).map(([key, rows]) => (
              <Panel key={key} title={t(`reports.ovr.${key}`)} className="pb-2">
                {rows.length === 0 ? (
                  <p className="m-0 px-3.5 text-muted-foreground">{t('reports.none')}</p>
                ) : (
                  <ul className="m-0 ps-8">
                    {rows.map((x) => (
                      <li key={x.key}>
                        {x.label} · <span className="tabular-nums">{x.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ))}
          </div>
          <Panel title={t('reports.ovr.list')} className="overflow-x-auto">
            <Table aria-label={t('reports.ovr.list')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports.col.time')}</TableHead>
                  <TableHead>{t('reports.col.kind')}</TableHead>
                  <TableHead>{t('reports.col.number')}</TableHead>
                  <TableHead>{t('reports.col.item')}</TableHead>
                  <TableHead>{t('reports.ovr.askedBy')}</TableHead>
                  <TableHead>{t('reports.ovr.approvedBy')}</TableHead>
                  <TableHead>{t('reports.col.reason')}</TableHead>
                  <TableHead className="text-end">{t('reports.ovr.list_')}</TableHead>
                  <TableHead className="text-end">{t('reports.ovr.price')}</TableHead>
                  <TableHead className="text-end">{t('reports.ovr.floor')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.overrides.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>
                      {o.businessDate} {time(o.at)}
                    </TableCell>
                    <TableCell>{kindName(t, o.kind)}</TableCell>
                    <TableCell className="font-mono">{o.billNumber}</TableCell>
                    <TableCell>{o.itemCode ? `${o.itemCode} ${o.itemName ?? ''}` : '—'}</TableCell>
                    <TableCell>{o.requestedByName}</TableCell>
                    <TableCell>{o.approvedByName}</TableCell>
                    <TableCell>{o.note ? `${o.reasonCode}: ${o.note}` : o.reasonCode}</TableCell>
                    <Num>{money(o.listPrice, report.money)}</Num>
                    <Num>{money(o.unitPrice, report.money)}</Num>
                    <Num>{money(o.floorPrice, report.money)}</Num>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {report.overrides.length === 0 && (
              <p className="m-0 p-3.5 text-muted-foreground">{t('reports.none')}</p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

const kindName = (t: TFunction, kind: string) => t(`reports.ovr.kinds.${kind}`, { defaultValue: kind });

// ---- Voids and returns (RPT-04) ----

export function VoidsReturnsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const r = useRange(api);
  const url = r.from && r.to ? `/api/reports/voids-returns?${r.query}` : null;
  const { report, error } = useReport<VoidsReturnsView>(api, url);
  return (
    <>
      <PageHeader title={t('reports.vr.title')} help={t('reports.vr.help')} />
      <Range from={r.from} to={r.to} onFrom={r.setFrom} onTo={r.setTo} csv={report && `${url}&format=csv`} />
      <Failed text={error} />
      {report && (
        <>
          <div className="grid gap-2.5 lg:grid-cols-3">
            <Totals
              title={t('reports.vr.voidsByReason')}
              m={report.money}
              rows={report.voidsByReason.map((x) => ({
                key: x.reason,
                label: x.reason,
                count: x.count,
                amount: null,
              }))}
            />
            <Totals
              title={t('reports.vr.returnsByReason')}
              m={report.money}
              rows={report.returnsByReason.map((x) => ({
                key: x.reason,
                label: x.reason,
                count: x.count,
                amount: x.amount,
              }))}
            />
            <Totals
              title={t('reports.vr.returnsByCondition')}
              m={report.money}
              rows={report.returnsByCondition.map((x) => ({
                key: x.condition,
                label: t(`reports.vr.condition.${x.condition}`),
                count: x.count,
                amount: x.amount,
              }))}
            />
          </div>
          <Panel title={t('reports.vr.voids')} className="overflow-x-auto">
            <Table aria-label={t('reports.vr.voids')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports.col.time')}</TableHead>
                  <TableHead>{t('reports.col.number')}</TableHead>
                  <TableHead>{t('reports.vr.bill')}</TableHead>
                  <TableHead>{t('reports.col.reason')}</TableHead>
                  <TableHead>{t('reports.vr.voidedBy')}</TableHead>
                  <TableHead>{t('reports.ovr.approvedBy')}</TableHead>
                  <TableHead>{t('reports.vr.reissue')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.voids.map((v) => (
                  <TableRow key={v.number}>
                    <TableCell>
                      {v.businessDate} {time(v.at)}
                    </TableCell>
                    <TableCell className="font-mono">{v.number}</TableCell>
                    <TableCell className="font-mono">{v.saleNumber}</TableCell>
                    <TableCell>{v.note ? `${v.reasonCode}: ${v.note}` : v.reasonCode}</TableCell>
                    <TableCell>{v.voidedByName}</TableCell>
                    <TableCell>{v.approvedByName}</TableCell>
                    <TableCell className="font-mono">{v.reissueNumber ?? '—'}</TableCell>
                    <Num>{money(v.saleTotal, report.money)}</Num>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {report.voids.length === 0 && (
              <p className="m-0 p-3.5 text-muted-foreground">{t('reports.none')}</p>
            )}
          </Panel>
          <Panel title={t('reports.vr.returns')} className="overflow-x-auto">
            <Table aria-label={t('reports.vr.returns')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports.col.date')}</TableHead>
                  <TableHead>{t('reports.col.number')}</TableHead>
                  <TableHead>{t('reports.col.salesman')}</TableHead>
                  <TableHead>{t('reports.col.item')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.qty')}</TableHead>
                  <TableHead>{t('reports.col.reason')}</TableHead>
                  <TableHead>{t('reports.vr.conditionTitle')}</TableHead>
                  <TableHead>{t('reports.vr.original')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.returns.map((x, i) => (
                  <TableRow key={`${x.billNumber}-${i}`}>
                    <TableCell>{x.businessDate}</TableCell>
                    <TableCell className="font-mono">{x.billNumber}</TableCell>
                    <TableCell>{x.salespersonName}</TableCell>
                    <TableCell>
                      {x.itemCode} {x.itemName}
                    </TableCell>
                    <Num>{qtyText(x.qty)}</Num>
                    <TableCell>{x.reasonCode}</TableCell>
                    <TableCell>{t(`reports.vr.condition.${x.condition}`)}</TableCell>
                    <TableCell className="font-mono">
                      {x.originalBillNumber ?? t('reports.vr.noReceipt')}
                    </TableCell>
                    <Num>{formatMoney(x.amount, report.money)}</Num>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {report.returns.length === 0 && (
              <p className="m-0 p-3.5 text-muted-foreground">{t('reports.none')}</p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

// ---- Stock and valuation (RPT-05, owner answer 7) ----

export function StockReportScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [below, setBelow] = useState(false);
  const url = `/api/reports/stock?q=${encodeURIComponent(text.trim())}${below ? '&below=1' : ''}`;
  const { report, error } = useReport<StockView>(api, url);
  return (
    <>
      <PageHeader title={t('reports.stock.title')} help={t('reports.stock.help')} />
      <Panel className="flex flex-wrap items-end gap-4 p-3.5">
        <TextField label={t('reports.stock.search')} value={text} onChange={(e) => setText(e.target.value)} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={below} onChange={(e) => setBelow(e.target.checked)} />
          {t('reports.stock.below')}
        </label>
        {report && (
          <Button asChild variant="outline">
            <a href={`${url}&format=csv`}>{t('reports.csv')}</a>
          </Button>
        )}
      </Panel>
      <Failed text={error} />
      {report && (
        <>
          <Panel className="flex flex-wrap gap-6 p-3.5">
            <span>
              <span className={LABEL_CLASS}>{t('reports.stock.onHand')}</span>{' '}
              <span className="font-semibold tabular-nums">{qtyText(report.total.qty)}</span>
            </span>
            {report.values && (
              <span>
                <span className={LABEL_CLASS}>{t('reports.stock.value')}</span>{' '}
                <span className="font-semibold tabular-nums">{money(report.total.value, report.money)}</span>
              </span>
            )}
            {report.noCost > 0 && (
              <span className="text-warn">{t('reports.stock.noCost', { count: report.noCost })}</span>
            )}
          </Panel>
          <div className="grid gap-2.5 lg:grid-cols-2">
            {(
              [
                [
                  'byLocation',
                  report.byLocation.map((x) => ({ key: x.code, label: x.name, qty: x.qty, value: x.value })),
                ],
                [
                  'byCategory',
                  report.byCategory.map((x) => ({
                    key: x.name,
                    label: x.name || '—',
                    qty: x.qty,
                    value: x.value,
                  })),
                ],
              ] as const
            ).map(([key, rows]) => (
              <Panel key={key} title={t(`reports.stock.${key}`)} className="pb-2">
                <Table aria-label={t(`reports.stock.${key}`)}>
                  <TableBody>
                    {rows.map((x) => (
                      <TableRow key={x.key}>
                        <TableCell>{x.label}</TableCell>
                        <Num>{qtyText(x.qty)}</Num>
                        {report.values && <Num>{money(x.value, report.money)}</Num>}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
            ))}
          </div>
          <Panel title={t('reports.stock.list')} className="overflow-x-auto">
            <Table aria-label={t('reports.stock.list')}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports.col.item')}</TableHead>
                  <TableHead>{t('reports.stock.category')}</TableHead>
                  <TableHead>{t('reports.stock.location')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.qty')}</TableHead>
                  {report.values && <TableHead className="text-end">{t('reports.stock.avgCost')}</TableHead>}
                  {report.values && <TableHead className="text-end">{t('reports.stock.value')}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((x) => (
                  <TableRow key={`${x.itemId}-${x.locationCode}`}>
                    <TableCell>
                      <a href={href.stockCard(x.itemId)} className="underline-offset-4 hover:underline">
                        <span className="font-mono">{x.itemCode}</span> {x.itemName}
                      </a>
                    </TableCell>
                    <TableCell>{x.categoryName ?? '—'}</TableCell>
                    <TableCell>{x.locationCode}</TableCell>
                    <TableCell className={`text-end tabular-nums ${x.qty < 0 ? 'text-bad' : ''}`}>
                      {qtyText(x.qty)}
                    </TableCell>
                    {report.values && (
                      <Num>
                        {x.avgCost === null ? t('reports.stock.noCostShort') : money(x.avgCost, report.money)}
                      </Num>
                    )}
                    {report.values && <Num>{money(x.value, report.money)}</Num>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {report.rows.length === 0 && (
              <p className="m-0 p-3.5 text-muted-foreground">{t('reports.none')}</p>
            )}
            {report.truncated && (
              <p className="m-0 p-3.5 text-muted-foreground">{t('reports.stock.truncated')}</p>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

// ---- Outstanding and ageing (RPT-06, owner answer 4) ----

const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;

export function AgeingScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [side, setSide] = useState<'customers' | 'suppliers'>('customers');
  // As on the shop's business date (W2-05) until another date is picked.
  const today = useShopToday(api) ?? '';
  const [picked, setAsOf] = useState<string | null>(null);
  const asOf = picked ?? today;
  const url = asOf ? `/api/reports/ageing?side=${side}&asOf=${encodeURIComponent(asOf)}` : null;
  const { report, error } = useReport<AgeingView>(api, url);
  return (
    <>
      <PageHeader title={t('reports.ageing.title')} help={t('reports.ageing.help')} />
      <Panel className="flex flex-wrap items-end gap-4 p-3.5">
        <div className="flex gap-1" role="group" aria-label={t('reports.ageing.side')}>
          {(['customers', 'suppliers'] as const).map((s) => (
            <Button
              key={s}
              variant={side === s ? 'default' : 'outline'}
              aria-pressed={side === s}
              onClick={() => setSide(s)}
            >
              {t(`reports.ageing.${s}`)}
            </Button>
          ))}
        </div>
        <DateField label={t('reports.ageing.asOf')} value={asOf} onChange={setAsOf} />
        {report && (
          <Button asChild variant="outline">
            <a href={`${url}&format=csv`}>{t('reports.csv')}</a>
          </Button>
        )}
      </Panel>
      <Failed text={error} />
      {report && (
        <Panel title={t(`reports.ageing.${report.side}`)} className="overflow-x-auto">
          <Table aria-label={t(`reports.ageing.${report.side}`)}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('reports.ageing.party')}</TableHead>
                <TableHead className="text-end">{t('reports.ageing.terms')}</TableHead>
                {BUCKETS.map((b) => (
                  <TableHead key={b} className="text-end">
                    {t(`reports.ageing.buckets.${b}`)}
                  </TableHead>
                ))}
                <TableHead className="text-end">{t('reports.ageing.balance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((x) => (
                <TableRow key={x.partyId}>
                  <TableCell>
                    <span className="font-mono">{x.code}</span> {x.name}
                  </TableCell>
                  <Num>{x.termsDays === null ? '—' : t('reports.ageing.days', { count: x.termsDays })}</Num>
                  {BUCKETS.map((b) => (
                    <TableCell
                      key={b}
                      className={`text-end tabular-nums ${b === 'over90' && x[b] > 0 ? 'text-bad' : ''}`}
                    >
                      {x[b] === 0 ? '' : formatMoney(x[b], report.money)}
                    </TableCell>
                  ))}
                  <TableCell className="text-end font-semibold tabular-nums">
                    {formatMoney(x.balance, report.money)}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-semibold">{t('reports.ageing.total')}</TableCell>
                <TableCell />
                {BUCKETS.map((b) => (
                  <TableCell key={b} className="text-end font-semibold tabular-nums">
                    {formatMoney(report.totals[b], report.money)}
                  </TableCell>
                ))}
                <TableCell className="text-end font-semibold tabular-nums">
                  {formatMoney(report.totals.balance, report.money)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p
            className={`m-0 p-3.5 text-sm ${report.controlBalance === report.totals.balance ? 'text-muted-foreground' : 'text-bad'}`}
          >
            {t(
              report.controlBalance === report.totals.balance
                ? 'reports.ageing.matches'
                : 'reports.ageing.differs',
              {
                account: t(`reports.ageing.control.${report.side}`),
                amount: formatMoney(report.controlBalance, report.money),
              },
            )}
          </p>
        </Panel>
      )}
    </>
  );
}

// ---- Exceptions (RPT-10, owner answer 5) ----

const SEVERITY_TONE = { high: 'bad', medium: 'warn', low: 'neutral' } as const;

export function ExceptionsScreen({ api, permissions }: { api: Api; permissions: readonly string[] }) {
  const { t } = useTranslation();
  const r = useRange(api);
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [version, setVersion] = useState(0);
  const [reviewing, setReviewing] = useState<ExceptionRow | null>(null);
  const url =
    r.from && r.to ? `/api/reports/exceptions?${r.query}${status === 'open' ? '&status=open' : ''}` : null;
  const { report, error } = useReport<ExceptionsView>(api, url, version);
  const canReview = permissions.includes('exceptions.review');
  return (
    <>
      <PageHeader title={t('reports.exc.title')} help={t('reports.exc.help')} />
      <Range from={r.from} to={r.to} onFrom={r.setFrom} onTo={r.setTo} csv={report && `${url}&format=csv`}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={status === 'all'}
            onChange={(e) => setStatus(e.target.checked ? 'all' : 'open')}
          />
          {t('reports.exc.showReviewed')}
        </label>
      </Range>
      <Failed text={error} />
      {report && (
        <Panel title={t('reports.exc.list')} className="overflow-x-auto">
          <Table aria-label={t('reports.exc.list')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('reports.col.date')}</TableHead>
                <TableHead>{t('reports.exc.kind')}</TableHead>
                <TableHead>{t('reports.exc.severity')}</TableHead>
                <TableHead>{t('reports.col.counter')}</TableHead>
                <TableHead>{t('reports.exc.document')}</TableHead>
                <TableHead>{t('reports.exc.status')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.exceptions.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    {e.businessDate} {time(e.createdAt)}
                  </TableCell>
                  <TableCell>{t(`reports.exc.kinds.${e.kind}`, { defaultValue: e.kind })}</TableCell>
                  <TableCell>
                    <StatusChip tone={SEVERITY_TONE[e.severity]}>
                      {t(`reports.exc.severities.${e.severity}`)}
                    </StatusChip>
                  </TableCell>
                  <TableCell>{e.deviceCode ?? '—'}</TableCell>
                  <TableCell className="font-mono">
                    {e.documentNumber && permissions.includes('support.trace') ? (
                      <a href={href.trace(e.documentNumber)} className="underline-offset-4 hover:underline">
                        {e.documentNumber}
                      </a>
                    ) : (
                      (e.documentNumber ?? '—')
                    )}
                  </TableCell>
                  <TableCell>
                    {t(`reports.exc.statuses.${e.status}`)}
                    {e.reviewedByName && (
                      <span className="block text-sm text-muted-foreground">
                        {e.reviewedByName}
                        {e.reviewNote ? `: ${e.reviewNote}` : ''}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {canReview && (
                      <Button size="sm" variant="outline" onClick={() => setReviewing(e)}>
                        {t('reports.exc.review')}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {report.exceptions.length === 0 && (
            <p className="m-0 p-3.5 text-muted-foreground">{t('reports.exc.none')}</p>
          )}
        </Panel>
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
    </>
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
            <span className="font-mono text-lg font-semibold">{trace.bill.number}</span>
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
                <li key={i} className="grid gap-x-3 sm:grid-cols-[11rem_7rem_1fr]">
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
