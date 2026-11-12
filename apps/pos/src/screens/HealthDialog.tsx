import { Alert, AlertDescription, LABEL_CLASS, TextField } from '@erp/ui';
import { PIN_MAX_FAILURES } from '@erp/domain';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CounterHealth } from '../counter';
import type { DiagnosticsResult } from '../sync/diagnostics';
import type { QuarantinedRow } from '../db/outbox';
import type { ApproverResult } from '../unlock/approve';
import type { StaffUser } from '../unlock/unlock';
import { Facts, FormDialog } from './BillDialogs';
import { StaffPicker } from './StaffPicker';

// Device health on the counter (POS spec §14, PLT-09, owner answer 4 to W1-07): anyone unlocked may look, offline too.
// *Needs attention* lists the bills the server refused; *Try again* needs a manager's own PIN (admin.devices).

/** Over 5 minutes, the clock is flagged (architecture §4.4). */
const SKEW_LIMIT_MS = 5 * 60_000;

export type RetryAttempt = (
  row: QuarantinedRow,
  manager: StaffUser,
  pin: string,
) => Promise<{ result: ApproverResult; failures: number }>;

/** *Send diagnostics* (PLT-12, owner answer 6 to W1-20): a manager's own PIN, then the log goes to support. */
export type SendAttempt = (
  manager: StaffUser,
  pin: string,
) => Promise<{ result: ApproverResult; failures: number; sent: DiagnosticsResult | null }>;

export function HealthDialog({
  health,
  attention,
  live,
  staff,
  locale,
  timeZone,
  onRetry,
  onSend,
  onClose,
}: {
  health: CounterHealth | null;
  attention: QuarantinedRow[];
  /** The SSE nudge is connected (sync spec §8). */
  live: boolean;
  staff: StaffUser[];
  locale: string;
  timeZone: string;
  onRetry: RetryAttempt;
  onSend: SendAttempt;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState<QuarantinedRow | null>(null);
  const [sending, setSending] = useState(false);
  const [manager, setManager] = useState<StaffUser | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const when = (iso: string | null) =>
    iso === null
      ? t('health.never')
      : new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(iso),
        );
  const megabytes = (bytes: number) =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 0 }).format(
      bytes / 1_000_000,
    );
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);

  const back = () => {
    setRetrying(null);
    setSending(false);
    setManager(null);
    setPin('');
  };

  const submit = async () => {
    if (retrying === null && !sending) return onClose();
    if (manager === null || pin === '') return;
    setBusy(true);
    const r = retrying !== null ? await onRetry(retrying, manager, pin) : await onSend(manager, pin);
    setBusy(false);
    setPin('');
    if (r.result === 'approved') {
      const sent: DiagnosticsResult | null = 'sent' in r ? (r.sent as DiagnosticsResult | null) : null;
      if (retrying !== null) setMessage({ ok: true, text: t('health.retried', { number: retrying.number }) });
      else if (sent === 'sent') setMessage({ ok: true, text: t('health.diagnostics.sent') });
      else {
        setMessage({ ok: false, text: t(`health.diagnostics.${sent ?? 'failed'}`) });
        return;
      }
      return back();
    }
    setMessage({
      ok: false,
      text:
        r.result === 'wrong'
          ? t('health.wrong', { count: PIN_MAX_FAILURES - r.failures })
          : r.result === 'approver_locked'
            ? t('health.locked')
            : t('health.notAllowed'),
    });
  };

  if (retrying !== null || sending)
    return (
      <FormDialog
        title={retrying !== null ? t('health.tryAgain') : t('health.diagnostics.title')}
        description={retrying !== null ? retrying.number : t('health.diagnostics.help')}
        actionLabel={retrying !== null ? t('health.tryAgain') : t('health.diagnostics.send')}
        busy={busy || manager === null}
        onClose={back}
        onSubmit={() => void submit()}
      >
        {manager === null ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-muted-foreground">{t('health.who')}</p>
            <StaffPicker staff={staff} onPick={setManager} shortCodeLabel={t('unlock.shortCode')} />
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span>
                <span className={LABEL_CLASS}>{t('health.manager')}</span>{' '}
                <span className="font-semibold">{manager.fullName}</span>
              </span>
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent text-sm text-focus underline"
                onClick={() => {
                  setManager(null);
                  setPin('');
                  setMessage(null);
                }}
              >
                {t('health.back')}
              </button>
            </div>
            <TextField
              label={t('health.pin')}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              className="text-center font-mono text-xl tracking-[.4em]"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </>
        )}
        {message && !message.ok && (
          <Alert variant="destructive">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
      </FormDialog>
    );

  const skew = health?.serverOffsetMs ?? null;
  const storage =
    health === null || health.storagePersisted === null
      ? t('health.unknown')
      : health.storagePersisted
        ? t('health.persisted')
        : t('health.notPersisted');
  return (
    <FormDialog
      title={t('health.title')}
      description={t('health.help')}
      actionLabel={t('health.close')}
      onClose={onClose}
      onSubmit={onClose}
    >
      {health && (
        <Facts
          facts={[
            [t('health.app'), health.appVersion],
            [t('health.schema'), health.schemaVersion],
            [
              t('health.storage'),
              health.storageUsage !== null && health.storageQuota !== null
                ? `${storage} · ${t('health.used', { used: megabytes(health.storageUsage), quota: megabytes(health.storageQuota) })}`
                : storage,
            ],
            [t('health.sse'), live ? t('health.sseOn') : t('health.sseOff')],
            [t('health.lastPull'), when(health.lastPullAt)],
            [t('health.lastPush'), when(health.lastPushAt)],
            [t('health.lastContact'), when(health.lastContactAt)],
            [
              t('health.clock'),
              skew === null
                ? t('health.unknown')
                : Math.abs(skew) > SKEW_LIMIT_MS
                  ? t('health.clockBad', { minutes: Math.round(skew / 60_000) })
                  : t('health.clockOk', { seconds: Math.round(skew / 1000) }),
            ],
            [t('health.waiting'), count(health.outboxCount)],
            [t('health.oldest'), when(health.oldestUnsyncedAt)],
            [t('health.events'), count(health.eventsWaiting)],
          ]}
        />
      )}
      <section aria-labelledby="health-attention" className="flex flex-col gap-2">
        <h3 id="health-attention" className="m-0 font-display text-lg">
          {t('health.attention')}
        </h3>
        {attention.length === 0 ? (
          <p className="m-0 text-muted-foreground">{t('health.noAttention')}</p>
        ) : (
          <>
            <p className="m-0 text-muted-foreground">{t('health.attentionHelp')}</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {attention.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 rounded-md bg-bad-soft px-3 py-2"
                >
                  <span>
                    <span className="font-mono font-semibold">{row.number}</span>{' '}
                    <span className="text-bad">
                      {t(`health.error.${row.error}`, { defaultValue: t('health.error.rejected') })}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border border-current bg-transparent px-2.5 py-1 text-sm font-semibold text-bad"
                    onClick={() => {
                      setMessage(null);
                      setRetrying(row);
                    }}
                  >
                    {t('health.tryAgain')}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {message?.ok && (
          <Alert role="status">
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
      </section>
      <section aria-labelledby="health-support" className="flex flex-col gap-2">
        <h3 id="health-support" className="m-0 font-display text-lg">
          {t('health.diagnostics.title')}
        </h3>
        <p className="m-0 text-muted-foreground">{t('health.diagnostics.help')}</p>
        <button
          type="button"
          className="cursor-pointer self-start rounded-md border border-current bg-transparent px-2.5 py-1 text-sm font-semibold"
          onClick={() => {
            setMessage(null);
            setSending(true);
          }}
        >
          {t('health.diagnostics.send')}
        </button>
      </section>
    </FormDialog>
  );
}
