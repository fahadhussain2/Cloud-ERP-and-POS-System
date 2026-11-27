import type { LockChecklist, PeriodsView } from '@erp/contracts';
import {
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
  TextField,
} from '@erp/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { FormDialog } from '../ui';
import { accountingRefusal, ErrorText, useAccountingLookups } from './data';

// Periods and the lock date (ACC-06, owner answer 5 to W1-19, D-108). The months are worked out from the shop's start
// month; a month is locked when it ends on or before the lock date. The accountant or the owner locks the next month
// once it is over, after a list of what still looks open (never blocking); only the owner reopens, with a reason.

export function PeriodsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const lookups = useAccountingLookups(api, version);
  const [periods, setPeriods] = useState<PeriodsView | null>(null);
  const [locking, setLocking] = useState<string | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', '/api/accounting/periods').then(
      (r) => live && setPeriods(r.status === 200 ? (r.body as PeriodsView) : null),
    );
    return () => {
      live = false;
    };
  }, [api, version]);
  if (lookups === null || periods === null)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const done = () => {
    setLocking(null);
    setReopening(null);
    setVersion((v) => v + 1);
  };
  return (
    <>
      <PageHeader
        title={t('accounting.periods.title')}
        help={t('accounting.periods.help', {
          lockDate: periods.lockDate ?? t('accounting.periods.none'),
        })}
        actions={
          lookups.can.close &&
          periods.next !== null && (
            <Button onClick={() => setLocking(periods.next)}>
              {t('accounting.periods.lockTo', { date: periods.next })}
            </Button>
          )
        }
      />
      {periods.years
        .slice()
        .reverse()
        .map((y) => (
          <Panel key={y.start} className="px-1.5 pb-2.5">
            <h2 className="m-0 px-2 pt-2 text-base font-semibold">
              {t('accounting.periods.year', { label: y.label })}
            </h2>
            <Table aria-label={t('accounting.periods.year', { label: y.label })}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('accounting.periods.month')}</TableHead>
                  <TableHead>{t('accounting.fields.status')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {y.months.map((m) => {
                  const isLast = m.end === periods.lockDate;
                  return (
                    <TableRow key={m.start}>
                      <TableCell>
                        {m.start} – {m.end}
                      </TableCell>
                      <TableCell>
                        {m.locked ? (
                          <StatusChip tone="neutral">{t('accounting.periods.locked')}</StatusChip>
                        ) : m.start > periods.today ? (
                          <StatusChip tone="neutral">{t('accounting.periods.notYet')}</StatusChip>
                        ) : (
                          <StatusChip tone="ok">{t('accounting.periods.open')}</StatusChip>
                        )}
                      </TableCell>
                      <TableCell className="text-end">
                        {isLast && lookups.can.reopen && (
                          <Button size="sm" variant="outline" onClick={() => setReopening(m.start)}>
                            {t('accounting.periods.reopen')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Panel>
        ))}
      {periods.history.length > 0 && (
        <Panel className="px-1.5 pb-2.5">
          <h2 className="m-0 px-2 pt-2 text-base font-semibold">{t('accounting.periods.history')}</h2>
          <Table aria-label={t('accounting.periods.history')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('accounting.periods.when')}</TableHead>
                <TableHead>{t('accounting.document.by')}</TableHead>
                <TableHead>{t('accounting.periods.change')}</TableHead>
                <TableHead>{t('accounting.periods.reason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {periods.history.map((h) => (
                <TableRow key={h.at}>
                  <TableCell>{new Date(h.at).toLocaleString(lookups.money.locale)}</TableCell>
                  <TableCell>{h.by ?? '—'}</TableCell>
                  <TableCell>{(h.from ?? t('accounting.periods.none')) + ' → ' + h.to}</TableCell>
                  <TableCell>{h.reason ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      )}
      {locking !== null && (
        <LockDialog
          api={api}
          lockDate={locking}
          money={lookups.money}
          onClose={() => setLocking(null)}
          onDone={done}
        />
      )}
      {reopening !== null && (
        <ReopenDialog api={api} monthStart={reopening} onClose={() => setReopening(null)} onDone={done} />
      )}
    </>
  );
}

function LockDialog({
  api,
  lockDate,
  money,
  onClose,
  onDone,
}: {
  api: Api;
  lockDate: string;
  money: Parameters<typeof formatMoney>[1];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [list, setList] = useState<LockChecklist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/accounting/periods/checklist?to=${lockDate}`).then(
      (r) => live && setList(r.status === 200 ? (r.body as LockChecklist) : { lockDate, items: [] }),
    );
    return () => {
      live = false;
    };
  }, [api, lockDate]);
  const submit = async () => {
    setBusy(true);
    const r = await api('POST', '/api/accounting/lock', { lockDate, reason: null });
    setBusy(false);
    if (r.status === 200) return onDone();
    setError(accountingRefusal(t, r.body));
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('accounting.periods.lockTitle', { date: lockDate })}
      description={t('accounting.periods.lockHelp')}
      actionLabel={t('accounting.periods.lock')}
      cancelLabel={t('accounting.cancel')}
      busy={busy || list === null}
      onSubmit={() => void submit()}
    >
      {list === null ? (
        <p className="m-0 text-muted-foreground">{t('app.loading')}</p>
      ) : list.items.length === 0 ? (
        <p className="m-0 text-sm" role="status">
          {t('accounting.periods.allClear')}
        </p>
      ) : (
        <ul className="m-0 list-disc ps-5 text-sm" aria-label={t('accounting.periods.stillOpen')}>
          {list.items.map((i) => (
            <li key={i.kind}>
              {t(`accounting.checklist.${i.kind}`, {
                count: i.count,
                amount: i.amount === null ? '' : formatMoney(i.amount, money),
              })}
            </li>
          ))}
        </ul>
      )}
      <ErrorText text={error} />
    </FormDialog>
  );
}

function ReopenDialog({
  api,
  monthStart,
  onClose,
  onDone,
}: {
  api: Api;
  monthStart: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Reopening a month moves the lock date to the end of the month before it.
  const before = new Date(`${monthStart}T00:00:00Z`);
  before.setUTCDate(0);
  const lockDate = before.toISOString().slice(0, 10);
  const submit = async () => {
    setBusy(true);
    const r = await api('POST', '/api/accounting/lock', { lockDate, reason });
    setBusy(false);
    if (r.status === 200) return onDone();
    setError(accountingRefusal(t, r.body));
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('accounting.periods.reopenTitle', { date: lockDate })}
      description={t('accounting.periods.reopenHelp')}
      actionLabel={t('accounting.periods.reopen')}
      cancelLabel={t('accounting.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <TextField
        label={t('accounting.periods.reason')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <ErrorText text={error} />
    </FormDialog>
  );
}
