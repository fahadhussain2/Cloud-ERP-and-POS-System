import type {
  AcknowledgementStatus,
  CashVarianceResponse,
  DayReconciliationResponse,
  ReportMoney,
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
  type ChipTone,
} from '@erp/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';

// The cash reports (CSH-08, RPT-02, cash desk spec, W1-11): the day reconciliation of one branch and business date,
// and the cash variance by session over a date range, each with its CSV. A manager acknowledges a waiting variance on
// the day reconciliation (owner answer 1); the API refuses the session's own cashier.

interface Branch {
  id: string;
  code: string;
  name: string;
}

/** A date as YYYY-MM-DD in this browser's time zone, `days` from today. */
const dayOf = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ACK_TONE: Record<AcknowledgementStatus, ChipTone> = {
  open: 'neutral',
  not_counted: 'warn',
  exact: 'ok',
  waiting: 'warn',
  acknowledged: 'ok',
};

const varianceTone = (v: number | null): string =>
  v === null || v === 0 ? '' : v < 0 ? 'text-bad' : 'text-warn';

function DateField({
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

export function DayReconciliationScreen({ api, permissions }: { api: Api; permissions: readonly string[] }) {
  const { t, i18n } = useTranslation();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState(() => dayOf(-1));
  const [report, setReport] = useState<DayReconciliationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayAcknowledge = permissions.includes('cash.variance.approve') || permissions.includes('*');

  useEffect(() => {
    void api('GET', '/api/branches').then((r) => {
      const list = r.status === 200 ? (r.body as Branch[]) : [];
      setBranches(list);
      setBranchId((id) => id || (list[0]?.id ?? ''));
    });
  }, [api]);

  const query = `branchId=${encodeURIComponent(branchId)}&date=${encodeURIComponent(date)}`;
  const fetchReport = useCallback(async (): Promise<DayReconciliationResponse | null | undefined> => {
    if (branchId === '' || date === '') return undefined;
    const r = await api('GET', `/api/reports/day-reconciliation?${query}`);
    return r.status === 200 ? (r.body as DayReconciliationResponse) : null;
  }, [api, branchId, date, query]);
  /** A report, or null when it couldn't be read (undefined: nothing to read yet). */
  const show = useCallback(
    (r: DayReconciliationResponse | null | undefined) => {
      if (r === undefined) return;
      setReport(r);
      setError(r === null ? t('reports.failed') : null);
    },
    [t],
  );
  useEffect(() => {
    let live = true;
    void fetchReport().then((r) => live && show(r));
    return () => {
      live = false;
    };
  }, [fetchReport, show]);

  const acknowledge = async (sessionId: string) => {
    const r = await api('POST', `/api/reports/cash-sessions/${encodeURIComponent(sessionId)}/acknowledge`);
    show(await fetchReport());
    if (r.status !== 200)
      setError(t(`reports.ack.${(r.body as { error?: string } | null)?.error ?? 'failed'}`));
  };

  const m = (minor: number, money: ReportMoney) => formatMoney(minor, money);
  const time = (iso: string | null) =>
    iso === null
      ? t('reports.never')
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        );

  return (
    <>
      <PageHeader title={t('reports.day.title')} help={t('reports.day.help')} />
      <Panel className="flex flex-wrap items-end gap-4 p-3.5">
        <label className="flex flex-col gap-1">
          <span className={LABEL_CLASS}>{t('reports.branch')}</span>
          <select
            className="h-9 rounded-md border border-input bg-surface px-2"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <DateField label={t('reports.day.date')} value={date} onChange={setDate} />
        {report && (
          <Button asChild variant="outline">
            <a href={`/api/reports/day-reconciliation?${query}&format=csv`}>{t('reports.csv')}</a>
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
          <Panel className="flex flex-col gap-2 p-3.5" aria-label={t('reports.day.status')}>
            <div className="flex items-center gap-3">
              <StatusChip tone={report.status === 'final' ? 'ok' : 'warn'}>
                {t(`reports.day.${report.status}`)}
              </StatusChip>
              <span>{t('reports.day.transit', { amount: m(report.cashInTransit, report.money) })}</span>
            </div>
            {report.holds.length > 0 && (
              <ul className="m-0 ps-5">
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
            )}
          </Panel>

          <Panel title={t('reports.day.sessions')} className="overflow-x-auto">
            {report.sessions.length === 0 ? (
              <p className="m-0 px-3.5 pb-3 text-muted-foreground">{t('reports.day.noSessions')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('reports.col.session')}</TableHead>
                    <TableHead>{t('reports.col.cashier')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.float')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.in')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.collected')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.out')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.expected')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.counted')}</TableHead>
                    <TableHead className="text-end">{t('reports.col.variance')}</TableHead>
                    <TableHead>{t('reports.col.acknowledgement')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.sessions.map((s) => {
                    const out =
                      s.paidOut +
                      s.cashOuts.expense +
                      s.cashOuts.supplier_payment +
                      s.cashOuts.bank_deposit +
                      s.cashOuts.to_safe -
                      s.cashOuts.from_safe;
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono">{s.number}</TableCell>
                        <TableCell>{s.cashierName}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {m(s.openingFloat, report.money)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{m(s.handedIn, report.money)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {m(s.cashCollections, report.money)}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{m(out, report.money)}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {m(s.expected, report.money)}
                          {s.expectedDiffers && (
                            <span className="block text-xs text-warn">
                              {t('reports.day.deskSaid', { amount: m(s.deskExpected ?? 0, report.money) })}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {s.counted === null ? '—' : m(s.counted, report.money)}
                        </TableCell>
                        <TableCell
                          className={`text-end font-semibold tabular-nums ${varianceTone(s.variance)}`}
                        >
                          {s.variance === null ? '—' : m(s.variance, report.money)}
                          {s.varianceReason && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {t(`reports.reason.${s.varianceReason}`)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <StatusChip tone={ACK_TONE[s.acknowledgement]}>
                              {s.acknowledgement === 'acknowledged'
                                ? t('reports.ack.by', { name: s.acknowledgedByName ?? '' })
                                : t(`reports.ack.${s.acknowledgement}`)}
                            </StatusChip>
                            {s.acknowledgement === 'waiting' && mayAcknowledge && (
                              <Button size="sm" variant="outline" onClick={() => void acknowledge(s.id)}>
                                {t('reports.ack.action')}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Panel>

          {report.missingHandovers !== null && (
            <Panel title={t('reports.day.missing')} className="flex flex-col gap-2 pb-3">
              {report.missingHandovers.length === 0 ? (
                <p className="m-0 px-3.5 text-muted-foreground">{t('reports.day.noMissing')}</p>
              ) : (
                report.missingHandovers.map((g) => (
                  <div key={g.sellerId} className="px-3.5">
                    <p className="m-0 font-semibold">
                      {g.sellerName ?? t('reports.unknownSeller')} ·{' '}
                      {t('reports.day.toCollect', { amount: m(g.toCollect, report.money) })}
                      {g.toPayOut > 0 &&
                        ` · ${t('reports.day.toPayOut', { amount: m(g.toPayOut, report.money) })}`}
                    </p>
                    <ul className="m-0 ps-5">
                      {g.bills.map((b) => (
                        <li key={b.number} className="font-mono">
                          {b.number} ·{' '}
                          {b.kind === 'in' ? m(b.amount, report.money) : `−${m(b.amount, report.money)}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </Panel>
          )}

          {report.unmatchedScans.length > 0 && (
            <Panel title={t('reports.day.unmatched')} className="pb-3">
              <ul className="m-0 ps-8">
                {report.unmatchedScans.map((h) => (
                  <li key={h.number}>
                    {t('reports.day.unmatchedRow', {
                      number: h.number,
                      bill: h.billNumber,
                      amount: m(h.amount, report.money),
                    })}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title={t('reports.day.exceptions')} className="pb-3">
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
    </>
  );
}

export function CashVarianceScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState(() => dayOf(-7));
  const [to, setTo] = useState(() => dayOf(0));
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
