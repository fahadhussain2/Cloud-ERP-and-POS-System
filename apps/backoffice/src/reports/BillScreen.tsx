import type { BillLineView, BillView } from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Button,
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
import type { TFunction } from 'i18next';
import { Activity, Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { qtyText } from '../catalog/data';
import { href } from '../router';
import { usePrintInfo } from './frame/ReportFrame';

// Bill details (W2-10 plan, D-125; the owner's mockup): one bill, read only, for anyone with reports.view. The header,
// who and where, the items with their approvals, the totals and payments, cost and profit (only with cost.view, which
// the API already leaves out), and what is related. Print prints this page on A4, headed with who printed it and when,
// never the counter's A5 bill. Strings are i18n keys (rule 10), money in the shop's format, CSS logical properties.

const s = (t: TFunction, key: string, o?: Record<string, unknown>) => t(`billDetails.${key}`, o ?? {});
const when = (at: string | null) =>
  at === null ? '' : new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function useBill(api: Api, number: string) {
  const url: string | null = `/api/sales/bills/${encodeURIComponent(number)}`;
  const [state, setState] = useState<{ url: string | null; bill: BillView | null; missing: boolean }>({
    url: null,
    bill: null,
    missing: false,
  });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    void api('GET', url).then((r) => {
      if (live)
        setState({ url, bill: r.status === 200 ? (r.body as BillView) : null, missing: r.status !== 200 });
    });
    return () => {
      live = false;
    };
  }, [api, url]);
  return {
    bill: state.url === url ? state.bill : null,
    missing: state.url === url && state.missing,
  };
}

const BillLink = ({ number }: { number: string }) => (
  <a href={href.bill(number)} className="font-mono underline-offset-4 hover:underline">
    {number}
  </a>
);

/** A label over its value, as in the mockup's "Who and where". */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-xs text-muted-foreground">{label}</span>
    <span className="font-medium">{children}</span>
  </div>
);

/** A label and an amount on one line. */
const Row = ({ label, value, strong }: { label: ReactNode; value: string; strong?: boolean }) => (
  <div className={`flex justify-between gap-3 tabular-nums ${strong ? 'text-lg font-bold' : 'text-sm'}`}>
    <span>{label}</span>
    <span>{value}</span>
  </div>
);

export function BillScreen({ api, number }: { api: Api; number: string }) {
  const { t } = useTranslation();
  const who = usePrintInfo();
  const { bill, missing } = useBill(api, number);
  const [printedAt, setPrintedAt] = useState(() => new Date());
  useEffect(() => {
    const stamp = () => setPrintedAt(new Date());
    window.addEventListener('beforeprint', stamp);
    return () => window.removeEventListener('beforeprint', stamp);
  }, []);

  return (
    <>
      {bill && (
        <div data-slot="print-header" className="hidden print:block">
          <p className="m-0 text-lg font-bold">{who.shopName}</p>
          <p className="m-0 text-base font-semibold">{s(t, 'printTitle', { number: bill.bill.number })}</p>
          <p className="m-0 text-xs">
            {t('reports.frame.printedBy', { name: who.userName, at: printedAt.toLocaleString() })}
          </p>
        </div>
      )}
      <div className="print:hidden">
        <PageHeader
          eyebrow={
            // Back to the list it belongs to (W2-11, D-126): Bills for a sale, Returns for a return or exchange.
            bill?.bill.kind === 'return' || bill?.bill.kind === 'exchange' ? (
              <a href={href.returns} className="underline-offset-4 hover:underline">
                ← {t('nav.returns')}
              </a>
            ) : (
              <a href={href.bills} className="underline-offset-4 hover:underline">
                ← {t('nav.bills')}
              </a>
            )
          }
          title={bill ? `${s(t, 'title')}: ${bill.bill.number}` : s(t, 'title')}
          help={s(t, 'help')}
          actions={
            bill && (
              <>
                {bill.canTrace && (
                  <Button asChild variant="outline">
                    <a href={href.trace(bill.bill.number)}>
                      <Activity aria-hidden="true" className="size-4" />
                      {s(t, 'trace')}
                    </a>
                  </Button>
                )}
                <Button onClick={() => window.print()}>
                  <Printer aria-hidden="true" className="size-4" />
                  {s(t, 'print')}
                </Button>
              </>
            )
          }
        />
      </div>
      {missing && (
        <Alert variant="destructive">
          <AlertDescription>{s(t, 'notFound', { number })}</AlertDescription>
        </Alert>
      )}
      {bill && <Bill view={bill} />}
    </>
  );
}

function Bill({ view }: { view: BillView }) {
  const { t } = useTranslation();
  const m = view.money;
  const money = (v: number | null) => (v === null ? '' : formatMoney(v, m));
  const b = view.bill;
  const h = view.handover;
  return (
    <div className="flex flex-col gap-4">
      {view.void && (
        <div role="status" className="rounded-[10px] border border-bad bg-bad-soft p-3.5 text-sm text-bad">
          {s(t, 'voided', {
            number: view.void.number ?? '',
            at: when(view.void.at),
            reason: view.void.reason ? s(t, `voidReasons.${view.void.reason}`) : '',
            by: view.void.approvedBy ?? '',
          })}
          {view.void.reissue && (
            <>
              {' '}
              {s(t, 'reissuedAs')} <BillLink number={view.void.reissue} />
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <StatusChip tone={b.status === 'voided' ? 'bad' : 'ok'}>{s(t, `status.${b.status}`)}</StatusChip>
        <StatusChip tone="neutral">{s(t, `kind.${b.kind}`)}</StatusChip>
        <span className="text-sm text-muted-foreground">
          {s(t, 'meta', { at: when(b.createdAt), device: b.device, tier: b.priceTier })}
        </span>
      </div>

      <Panel
        aria-label={s(t, 'who')}
        className="grid grid-cols-1 gap-x-6 gap-y-3.5 p-3.5 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Fact label={s(t, 'salesman')}>{b.salesman}</Fact>
        <Fact label={s(t, 'customer')}>
          {b.customer ? (
            <a href={href.customer(b.customer.id)} className="underline-offset-4 hover:underline">
              {b.customer.name} ({b.customer.code})
            </a>
          ) : b.walkinPhone ? (
            s(t, 'walkInPhone', { phone: b.walkinPhone })
          ) : (
            s(t, 'walkIn')
          )}
        </Fact>
        <Fact label={s(t, 'handover')}>
          {s(t, `handoverStates.${h.status}`, {
            number: h.number ?? '',
            desk: h.desk ?? '',
            cashier: h.cashier ?? '',
            at: when(h.at),
          })}
        </Fact>
        <Fact label={s(t, 'businessDate')}>{b.businessDate}</Fact>
      </Panel>

      <Items view={view} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          aria-label={s(t, 'totals')}
          title={s(t, 'totals')}
          className="flex flex-col gap-2 px-3.5 pb-3.5"
        >
          <Row label={s(t, 'linesTotal')} value={money(view.totals.lines)} />
          <Row
            label={
              <>
                {s(t, 'billDiscount')}
                {view.billApprovals.map((a, i) => (
                  <span key={i} className="text-muted-foreground">
                    {' · '}
                    {s(t, 'approvedBy', { reason: s(t, `reasons.${a.reason}`), by: a.approvedBy })}
                  </span>
                ))}
              </>
            }
            value={money(-view.totals.billDiscount)}
          />
          <Row label={s(t, 'rounding')} value={money(view.totals.rounding)} />
          {view.totals.tax !== 0 && <Row label={s(t, 'tax')} value={money(view.totals.tax)} />}
          <div className="border-t border-line pt-2">
            <Row label={s(t, 'total')} value={money(view.totals.total)} strong />
          </div>
          <h3 className="m-0 mt-2 text-xs font-semibold tracking-[.06em] text-muted-foreground uppercase">
            {s(t, 'paid')}
          </h3>
          {view.payments.map((p, i) => (
            <Row
              key={i}
              label={
                <>
                  {p.name}
                  {p.cashReceived !== null && (
                    <span className="text-muted-foreground">
                      {' · '}
                      {s(t, 'cashDetail', { received: money(p.cashReceived), change: money(p.change ?? 0) })}
                    </span>
                  )}
                  {p.reference && (
                    <span className="text-muted-foreground">
                      {' · '}
                      {s(t, 'reference', { reference: p.reference })}
                    </span>
                  )}
                </>
              }
              value={money(p.amount)}
            />
          ))}
        </Panel>

        <div className="flex flex-col gap-4">
          {view.cost && (
            <Panel
              aria-label={s(t, 'costProfit')}
              title={s(t, 'costProfit')}
              className="flex flex-col gap-2 px-3.5 pb-3.5"
            >
              <Row label={s(t, 'cost')} value={money(view.cost.cost)} />
              <Row
                label={s(t, 'profit')}
                value={
                  view.cost.marginBp === null
                    ? money(view.cost.profit)
                    : `${money(view.cost.profit)} · ${(view.cost.marginBp / 100).toLocaleString(m.locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`
                }
                strong
              />
              {view.cost.noCostLines > 0 && (
                <p className="m-0 rounded-md bg-warn-soft p-2 text-sm text-warn">
                  {s(t, 'noCostNote', { count: view.cost.noCostLines })}
                </p>
              )}
            </Panel>
          )}
          <Related view={view} />
        </div>
      </div>

      <p className="m-0 text-xs text-muted-foreground">{s(t, 'readOnly')}</p>
    </div>
  );
}

function Items({ view }: { view: BillView }) {
  const { t } = useTranslation();
  const m = view.money;
  const money = (v: number | null) => (v === null ? '—' : formatMoney(v, m));
  const values = view.values;
  const note = (l: BillLineView) => [
    ...l.approvals.map((a) =>
      s(t, `approval.${a.kind}`, { by: a.approvedBy, defaultValue: `${a.kind}: ${a.approvedBy}` }),
    ),
    ...(l.noCost ? [s(t, 'noCost')] : []),
  ];
  return (
    <Panel aria-label={s(t, 'items')} className="pb-2">
      <div className="flex items-baseline justify-between px-3.5 pt-2.5 pb-1.5">
        <h2 className="m-0 font-display text-[15px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
          {s(t, 'items')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {s(t, 'lineCount', { count: view.lines.length })}
        </span>
      </div>
      <div className="overflow-x-auto">
        <Table aria-label={s(t, 'items')}>
          <TableHeader>
            <TableRow>
              <TableHead>{s(t, 'col.no')}</TableHead>
              <TableHead>{s(t, 'col.item')}</TableHead>
              <TableHead className="text-end">{s(t, 'col.qty')}</TableHead>
              <TableHead className="text-end">{s(t, 'col.list')}</TableHead>
              <TableHead className="text-end">{s(t, 'col.price')}</TableHead>
              <TableHead className="text-end">{s(t, 'col.discount')}</TableHead>
              <TableHead className="text-end">{s(t, 'col.amount')}</TableHead>
              {values && <TableHead className="border-s border-line text-end">{s(t, 'col.cost')}</TableHead>}
              {values && <TableHead className="text-end">{s(t, 'col.profit')}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.lines.map((l) => (
              <TableRow key={l.lineNo} className="align-top">
                <TableCell className="text-muted-foreground">{l.lineNo}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span>
                      <a
                        href={href.item(l.itemId)}
                        className="font-mono text-sm underline-offset-4 hover:underline"
                      >
                        {l.code}
                      </a>{' '}
                      <span className="font-medium">{l.name}</span>
                    </span>
                    {l.location && <span className="text-xs text-muted-foreground">{l.location}</span>}
                    {l.returned && (
                      <span className="text-xs text-muted-foreground">
                        {l.returned.billNumber ? (
                          <>
                            {s(t, 'returnedFrom')} <BillLink number={l.returned.billNumber} />
                          </>
                        ) : (
                          s(t, 'noReceipt')
                        )}
                        {' · '}
                        {s(t, `returnReasons.${l.returned.reason}`)}
                        {' · '}
                        {s(t, `conditions.${l.returned.condition}`)}
                        {l.returned.note ? ` · ${l.returned.note}` : ''}
                      </span>
                    )}
                    {(values ? note(l) : note({ ...l, noCost: false })).map((n, i) => (
                      <span key={i} className="self-start">
                        <StatusChip tone="warn">{n}</StatusChip>
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-end tabular-nums">{qtyText(l.qty)}</TableCell>
                <TableCell className="text-end text-muted-foreground tabular-nums">
                  {money(l.listPrice)}
                </TableCell>
                <TableCell className="text-end tabular-nums">{money(l.unitPrice)}</TableCell>
                <TableCell className="text-end text-muted-foreground tabular-nums">
                  {l.lineDiscount === 0 ? '—' : money(l.lineDiscount)}
                </TableCell>
                <TableCell className="text-end font-semibold tabular-nums">{money(l.amount)}</TableCell>
                {values && (
                  <TableCell className="border-s border-line text-end text-muted-foreground tabular-nums">
                    {money(l.cost)}
                  </TableCell>
                )}
                {values && <TableCell className="text-end tabular-nums">{money(l.profit)}</TableCell>}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

function Related({ view }: { view: BillView }) {
  const { t } = useTranslation();
  const r = view.related;
  const money = (v: number) => formatMoney(v, view.money);
  return (
    <Panel
      aria-label={s(t, 'related')}
      title={s(t, 'related')}
      className="flex flex-col gap-2 px-3.5 pb-3.5 text-sm"
    >
      {r.returns.map((x) => (
        <div key={x.number}>
          {s(t, 'returns')} <BillLink number={x.number} /> · {x.date} · {money(x.total)}
          {x.status === 'voided' && (
            <>
              {' '}
              <StatusChip tone="bad">{s(t, 'status.voided')}</StatusChip>
            </>
          )}
        </div>
      ))}
      {r.returnOf && (
        <div>
          {s(t, 'returnOf')} <BillLink number={r.returnOf} />
        </div>
      )}
      {r.reissueOf && (
        <div>
          {s(t, 'reissueOf')} <BillLink number={r.reissueOf} />
        </div>
      )}
      {r.approvals.length > 0 && (
        <div>
          {s(t, 'approvals')}:{' '}
          {r.approvals
            .map(
              (a) =>
                `${s(t, `approvalKinds.${a.kind}`)}, ${s(t, 'approvedBy', { reason: s(t, `reasons.${a.reason}`, { defaultValue: a.reason }), by: a.approvedBy })}`,
            )
            .join('; ')}
        </div>
      )}
      <div className="text-muted-foreground">
        {r.journal ? s(t, 'journal', { number: r.journal }) : s(t, 'notPosted')}
      </div>
    </Panel>
  );
}
