import { Badge, cn } from '@erp/ui';
import { useTranslation } from 'react-i18next';

import type { OfflineLevel } from '../sync/offline';

export interface Connection {
  /** null until the first pull or push has answered. */
  state: 'online' | 'offline' | 'refused' | null;
  offlineSince: Date | null;
}

/**
 * Always on screen, at the top (POS spec §7, POS-14, W1-03 owner answer 1): the shop and counter, the real state of
 * the connection and of the unsynced bills, and who is selling.
 */
export function StatusBar({
  shopName,
  deviceCode,
  connection,
  outboxCount,
  lastSyncAt,
  userName,
  timeZone,
  attention,
  offline,
  onOpenHealth,
}: {
  shopName: string | null;
  deviceCode: string | null;
  connection: Connection;
  outboxCount: number;
  lastSyncAt: string | null;
  userName: string | null;
  timeZone: string | undefined;
  /** Bills the server refused. */
  attention: number;
  /** The offline warning (SYN-06): its level and the hours since the last contact. Selling is never blocked. */
  offline: { level: OfflineLevel; hours: number };
  onOpenHealth: () => void;
}) {
  const { t, i18n } = useTranslation();
  const time = (d: Date) =>
    new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(
      d,
    );
  const pill = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold';

  return (
    <header className="status-bar flex flex-wrap items-center gap-x-4.5 gap-y-2.5">
      <div className="me-auto flex flex-wrap items-baseline gap-2.5">
        <span className="font-display text-[26px] font-bold tracking-[.02em] text-primary">
          {shopName ?? t('app.title')}
        </span>
        {deviceCode && (
          <span className="device-code font-display text-lg font-semibold tracking-[.04em] uppercase">
            {deviceCode}
          </span>
        )}
      </div>
      {connection.state === 'online' && (
        <span className={cn(pill, 'online bg-ok-soft text-ok')}>
          <span className="size-2 rounded-full bg-current" aria-hidden />
          {t('status.online')}
        </span>
      )}
      {connection.state === 'offline' && connection.offlineSince && (
        <span className={cn(pill, 'offline bg-bad-soft text-bad')}>
          <span className="size-2 rounded-full bg-current" aria-hidden />
          {t('status.offlineSince', { time: time(connection.offlineSince) })}
        </span>
      )}
      {connection.state === 'refused' && (
        <span className={cn(pill, 'bg-bad-soft text-bad')}>{t('status.refused')}</span>
      )}
      {/* The sync figures open the counter's health page (POS spec §14), like Alt+S. */}
      <button
        type="button"
        className="sync-area flex cursor-pointer flex-wrap items-center gap-x-4.5 gap-y-2.5 border-0 bg-transparent p-0 text-start"
        title={t('status.openHealth')}
        aria-label={t('status.openHealth')}
        onClick={onOpenHealth}
      >
        {attention > 0 && (
          <Badge className="attention border-transparent bg-bad-soft text-[12.5px] text-bad">
            {t('status.attention', { count: attention })}
          </Badge>
        )}
        <Badge
          variant="outline"
          className={cn(
            'waiting text-[12.5px]',
            outboxCount > 0 && 'border-transparent bg-warn-soft text-warn',
          )}
        >
          {t('status.waiting', { count: outboxCount })}
        </Badge>
        <span className="text-[12.5px] text-muted-foreground">
          {lastSyncAt ? t('status.lastSync', { time: time(new Date(lastSyncAt)) }) : t('status.neverSynced')}
        </span>
      </button>
      <span className="user font-semibold">{userName ?? t('status.locked')}</span>
      {offline.level !== 'none' && (
        <p
          role="status"
          className={cn(
            'offline-warning m-0 basis-full rounded-md px-3 py-2 text-[13.5px] font-semibold',
            offline.level === 'strong' ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn',
          )}
        >
          {offline.level === 'strong'
            ? t('status.offlineStrong', { days: Math.floor(offline.hours / 24) })
            : t('status.offlineWarning', { hours: Math.floor(offline.hours) })}
        </p>
      )}
    </header>
  );
}
