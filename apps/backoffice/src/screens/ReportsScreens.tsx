import type { AcknowledgementStatus, CashVarianceResponse, DayReconciliationResponse } from '@erp/contracts';
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
  type ChipTone,
} from '@erp/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { apiQuery, current, only, useFilters, type Filters } from '../reports/frame/filters';
import {
  ChoiceFilter,
  DateFilter,
  ListTable,
  ReportPage,
  useReport,
  type ListColumn,
} from '../reports/frame/ReportFrame';
import { addDays, useShopToday } from '../shopDay';

// The cash reports (CSH-08, RPT-02, cash desk spec, W1-11), on the report frame since W2-04 (answer 8; D-116): the
// day reconciliation of one branch and business date, and the cash variance by session over a date range, each with
// its CSV and print layout. A manager acknowledges a waiting variance on the day reconciliation (owner answer 1); the
// API refuses the session's own cashier. Every figure is the API's, as before.

interface Branch {
  id: string;
  code: string;
  name: string;
}

const ACK_TONE: Record<AcknowledgementStatus, ChipTone> = {
  open: 'neutral',
  not_counted: 'warn',
  exact: 'ok',
  waiting: 'warn',
  acknowledged: 'ok',
};

const varianceTone = (v: number | null): string =>
  v === null || v === 0 ? '' : v < 0 ? 'text-bad' : 'text-warn';

export function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL_CLASS}>{label}</span>
      <input
        type="date"
        className="h-9 rounded-md border border-input bg-surface px-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

type Session = DayReconciliationResponse['sessions'][number];

/** Every rupee out of a session; what came in from the safe is shown beside it, never netted off. */
const outOf = (s: Session) =>
  s.paidOut +
  s.cashOuts.expense +
  s.cashOuts.supplier_payment +
  s.cashOuts.bank_deposit +
  s.cashOuts.to_safe +
  // Cash given back for a voided bill (W1-23).
  s.cashOuts.void_cash;

export function DayReconciliationScreen({ api, permissions }: { api: Api; permissions: readonly string[] }) {
  const { t, i18n } = useTranslation();
  const [branches, setBranches] = useState<Branch[]>([]);
  // The branch and the date are in the address; the date isn't remembered, so the report opens on the business day
  // before the shop's (D-117) again.
  const [filters, setFilters] = useFilters('dayReconciliation', { forget: ['date'] });
  const today = useShopToday(api);
  const branchId = filters['branchId'] || (branches[0]?.id ?? '');
  const date = filters['date'] || (today === null ? '' : addDays(today, -1));
  const [version, setVersion] = useState(0);
  const [ackError, setAckError] = useState<string | null>(null);
  const set = (next: Filters) => {
    setAckError(null);
    setFilters(only({ branchId, ...current(filters), ...next }, ['branchId', 'date']));
  };
  const mayAcknowledge = permissions.includes('cash.variance.approve') || permissions.includes('*');

  useEffect(() => {
    void api('GET', '/api/branches').then((r) => setBranches(r.status === 200 ? (r.body as Branch[]) : []));
  }, [api]);

  const url =
    branchId !== '' && date !== '' ? `/api/reports/day-reconciliation?${apiQuery({ branchId, date })}` : null;
  const { report, error } = useReport<DayReconciliationResponse>(api, url, version);

  const acknowledge = async (sessionId: string) => {
    const r = await api('POST', `/api/reports/cash-sessions/${encodeURIComponent(sessionId)}/acknowledge`);
    setAckError(
      r.status === 200 ? null : t(`reports.ack.${(r.body as { error?: string } | null)?.error ?? 'failed'}`),
    );
    setVersion((v) => v + 1);
  };

  const time = (iso: string | null) =>
    iso === null
      ? t('reports.never')
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        );
  const m = report?.money;
  const money = (minor: number) => (m ? formatMoney(minor, m) : '');
  const branchName = branches.find((b) => b.id === branchId)?.name ?? '';

  const columns: ListColumn<Session>[] = [
    {
      key: 'session',
      label: t('reports.col.session'),
      sort: (s) => s.number,
      cell: (s) => <span className="font-mono">{s.number}</span>,
    },
    {
      key: 'cashier',
      label: t('reports.col.cashier'),
      sort: (s) => s.cashierName,
      cell: (s) => s.cashierName,
    },
    {
      key: 'float',
      label: t('reports.col.float'),
      end: true,
      sort: (s) => s.openingFloat,
      cell: (s) => money(s.openingFloat),
    },
    {
      key: 'in',
      label: t('reports.col.in'),
      end: true,
      sort: (s) => s.handedIn,
      cell: (s) => money(s.handedIn),
    },
    {
      key: 'collected',
      label: t('reports.col.collected'),
      end: true,
      sort: (s) => s.cashCollections,
      cell: (s) => money(s.cashCollections),
    },
    {
      key: 'out',
      label: t('reports.col.out'),
      end: true,
      sort: outOf,
      cell: (s) => (
        <>
          {money(outOf(s))}
          {s.cashOuts.from_safe > 0 && (
            <span className="block text-xs text-muted-foreground">
              {t('reports.day.fromSafe', { amount: money(s.cashOuts.from_safe) })}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'expected',
      label: t('reports.col.expected'),
      end: true,
      sort: (s) => s.expected,
      cell: (s) => (
        <>
          {money(s.expected)}
          {s.expectedDiffers && (
            <span className="block text-xs text-warn">
              {t('reports.day.deskSaid', { amount: money(s.deskExpected ?? 0) })}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'counted',
      label: t('reports.col.counted'),
      end: true,
      sort: (s) => s.counted ?? -Infinity,
      cell: (s) => (s.counted === null ? '—' : money(s.counted)),
    },
    {
      key: 'variance',
      label: t('reports.col.variance'),
      end: true,
      sort: (s) => s.variance ?? -Infinity,
      cell: (s) => (
        <span className={`font-semibold ${varianceTone(s.variance)}`}>
          {s.variance === null ? '—' : money(s.variance)}
          {s.varianceReason && (
            <span className="block text-xs font-normal text-muted-foreground">
              {t(`reports.reason.${s.varianceReason}`)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'acknowledgement',
      label: t('reports.col.acknowledgement'),
      sort: (s) => s.acknowledgement,
      cell: (s) => (
        <div className="flex items-center gap-2">
          <StatusChip tone={ACK_TONE[s.acknowledgement]}>
            {s.acknowledgement === 'acknowledged'
              ? t('reports.ack.by', { name: s.acknowledgedByName ?? '' })
              : t(`reports.ack.${s.acknowledgement}`)}
          </StatusChip>
          {s.acknowledgement === 'waiting' && mayAcknowledge && (
            <Button
              size="sm"
              variant="outline"
              className="print:hidden"
              onClick={() => void acknowledge(s.id)}
            >
              {t('reports.ack.action')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <ReportPage
      title={t('reports.day.title')}
      help={t('reports.day.help')}
      filters={
        <>
          <ChoiceFilter
            label={t('reports.branch')}
            value={branchId}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(v) => set({ branchId: v })}
          />
          <DateFilter label={t('reports.day.date')} value={date} onChange={(v) => set({ date: v })} />
        </>
      }
      printFilters={`${branchName} · ${date}`}
      csv={report && `${url}&format=csv`}
      error={error ?? ackError}
      loading={report === null && error === null}
      figures={
        report
          ? [
              {
                key: 'status',
                label: t('reports.day.status'),
                value: (
                  <StatusChip tone={report.status === 'final' ? 'ok' : 'warn'}>
                    {t(`reports.day.${report.status}`)}
                  </StatusChip>
                ),
              },
              { key: 'transit', label: t('reports.day.inTransit'), value: money(report.cashInTransit) },
            ]
          : []
      }
    >
      {report && (
        <>
          {report.holds.length > 0 && (
            <Panel title={t('reports.day.holds')} className="pb-3">
              <ul className="m-0 ps-8">
                {report.holds.map((h, i) => (
                  <li key={i}>
                    {h.kind === 'day_not_over'
                      ? t('reports.hold.day_not_over', { time: time(h.dayEndsAt) })
                      : h.kind === 'device_not_heard'
                        ? t('reports.hold.device_not_heard', {
                            device: h.deviceCode,
                            time: time(h.lastContactAt),
                          })
                        : h.kind === 'device_unsynced'
                          ? t('reports.hold.device_unsynced', {
                              device: h.deviceCode,
                              time: time(h.oldestUnsyncedAt),
                            })
                          : h.kind === 'sequence_gap'
                            ? t('reports.hold.sequence_gap', {
                                device: h.deviceCode,
                                from: `${h.family}${h.fromSeq}`,
                                to: `${h.family}${h.toSeq}`,
                              })
                            : t('reports.hold.session_open', { number: h.number, name: h.cashierName })}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <h2 className="m-0 text-base font-semibold">{t('reports.day.sessions')}</h2>
          <ListTable
            label={t('reports.day.sessions')}
            columns={columns}
            rows={report.sessions}
            rowKey={(s) => s.id}
            text={(s) => `${s.number} ${s.deviceCode} ${s.cashierName}`}
            empty={t('reports.day.noSessions')}
          />

          {report.missingHandovers !== null && (
            <Panel title={t('reports.day.missing')} className="flex flex-col gap-2 pb-3 break-inside-avoid">
              {report.missingHandovers.length === 0 ? (
                <p className="m-0 px-3.5 text-muted-foreground">{t('reports.day.noMissing')}</p>
              ) : (
                report.missingHandovers.map((g) => (
                  <div key={g.sellerId} className="px-3.5">
                    <p className="m-0 font-semibold">
                      {g.sellerName ?? t('reports.unknownSeller')} ·{' '}
                      {t('reports.day.toCollect', { amount: money(g.toCollect) })}
                      {g.toPayOut > 0 && ` · ${t('reports.day.toPayOut', { amount: money(g.toPayOut) })}`}
                    </p>
                    <ul className="m-0 ps-5">
                      {g.bills.map((b) => (
                        <li key={b.number} className="font-mono">
                          {b.number} · {b.kind === 'in' ? money(b.amount) : `−${money(b.amount)}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </Panel>
          )}

          {report.voidCash.length > 0 && (
            <Panel title={t('reports.day.voidCash')} className="pb-3 break-inside-avoid">
              <ul className="m-0 ps-8">
                {report.voidCash.map((v) => (
                  <li key={v.billNumber}>
                    {v.givenBack === null
                      ? t('reports.day.voidCashOpen', {
                          bill: v.billNumber,
                          void: v.voidNumber,
                          amount: money(v.amount),
                        })
                      : t('reports.day.voidCashGivenBack', {
                          bill: v.billNumber,
                          void: v.voidNumber,
                          amount: money(v.amount),
                          number: v.givenBack.number,
                          date: v.givenBack.businessDate,
                        })}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {report.unmatchedScans.length > 0 && (
            <Panel title={t('reports.day.unmatched')} className="pb-3 break-inside-avoid">
              <ul className="m-0 ps-8">
                {report.unmatchedScans.map((h) => (
                  <li key={h.number}>
                    {t('reports.day.unmatchedRow', {
                      number: h.number,
                      bill: h.billNumber,
                      amount: money(h.amount),
                    })}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title={t('reports.day.exceptions')} className="pb-3 break-inside-avoid">
            {report.exceptions.length === 0 ? (
              <p className="m-0 px-3.5 text-muted-foreground">{t('reports.day.noExceptions')}</p>
            ) : (
              <ul className="m-0 ps-8">
                {report.exceptions.map((e) => (
                  <li key={e.kind}>
                    {e.kind} · {t(`reports.severity.${e.severity}`)} · {e.count}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </ReportPage>
  );
}

export function CashVarianceScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  // The 7 days up to the shop's business date (W2-05), until other dates are picked.
  const today = useShopToday(api);
  const [pickedFrom, setFrom] = useState<string | null>(null);
  const [pickedTo, setTo] = useState<string | null>(null);
  const from = pickedFrom ?? (today === null ? '' : addDays(today, -7));
  const to = pickedTo ?? today ?? '';
  const [report, setReport] = useState<CashVarianceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  useEffect(() => {
    let live = true;
    if (from === '' || to === '') return;
    void api('GET', `/api/reports/cash-variance?${query}`).then((r) => {
      if (!live) return;
      if (r.status === 200) {
        setReport(r.body as CashVarianceResponse);
        setError(null);
      } else {
        setReport(null);
        setError(t('reports.failed'));
      }
    });
    return () => {
      live = false;
    };
  }, [api, from, to, query, t]);

  return (
    <>
      <PageHeader title={t('reports.variance.title')} help={t('reports.variance.help')} />
      <Panel className="flex flex-wrap items-end gap-4 p-3.5">
        <DateField label={t('reports.variance.from')} value={from} onChange={setFrom} />
        <DateField label={t('reports.variance.to')} value={to} onChange={setTo} />
        {report && (
          <Button asChild variant="outline">
            <a href={`/api/reports/cash-variance?${query}&format=csv`}>{t('reports.csv')}</a>
          </Button>
        )}
      </Panel>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {report && (
        <>
          <Panel title={t('reports.variance.byCashier')} className="pb-3">
            {report.byCashier.length === 0 ? (
              <p className="m-0 px-3.5 text-muted-foreground">{t('reports.variance.none')}</p>
            ) : (
              <ul className="m-0 ps-8">
                {report.byCashier.map((c) => (
                  <li key={c.cashierName}>
                    <span className="font-semibold">{c.cashierName}</span> ·{' '}
                    {t('reports.variance.sessions', { count: c.sessions })} ·{' '}
                    <span className={varianceTone(c.variance)}>{formatMoney(c.variance, report.money)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title={t('reports.variance.sessionsTitle')} className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports.col.date')}</TableHead>
                  <TableHead>{t('reports.col.session')}</TableHead>
                  <TableHead>{t('reports.col.cashier')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.expected')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.counted')}</TableHead>
                  <TableHead className="text-end">{t('reports.col.variance')}</TableHead>
                  <TableHead>{t('reports.col.acknowledgement')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.sessions.map((s) => (
                  <TableRow key={s.sessionId}>
                    <TableCell>{s.businessDate}</TableCell>
                    <TableCell className="font-mono">{s.number}</TableCell>
                    <TableCell>{s.cashierName}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {s.expected === null ? '—' : formatMoney(s.expected, report.money)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {s.counted === null ? '—' : formatMoney(s.counted, report.money)}
                    </TableCell>
                    <TableCell className={`text-end font-semibold tabular-nums ${varianceTone(s.variance)}`}>
                      {s.variance === null ? '—' : formatMoney(s.variance, report.money)}
                    </TableCell>
                    <TableCell>
                      <StatusChip tone={ACK_TONE[s.acknowledgement]}>
                        {s.acknowledgement === 'acknowledged'
                          ? t('reports.ack.by', { name: s.acknowledgedByName ?? '' })
                          : t(`reports.ack.${s.acknowledgement}`)}
                      </StatusChip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </>
      )}
    </>
  );
}
