import { useTranslation } from 'react-i18next';

export interface Connection {
  /** null until the first pull has answered. */
  state: 'online' | 'offline' | 'refused' | null;
  offlineSince: Date | null;
}

/** Always on screen (POS spec §7, POS-14): the real state of the connection and of the unsynced bills. */
export function StatusBar({
  deviceCode,
  connection,
  outboxCount,
  lastSyncAt,
  userName,
  timeZone,
}: {
  deviceCode: string | null;
  connection: Connection;
  outboxCount: number;
  lastSyncAt: string | null;
  userName: string | null;
  timeZone: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const time = (d: Date) =>
    new Intl.DateTimeFormat(i18n.language, { timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(
      d,
    );

  return (
    <footer className="status-bar">
      {deviceCode && <span className="device-code">{deviceCode}</span>}
      {connection.state === 'online' && <span className="online">{t('status.online')}</span>}
      {connection.state === 'offline' && connection.offlineSince && (
        <span className="offline">{t('status.offlineSince', { time: time(connection.offlineSince) })}</span>
      )}
      {connection.state === 'refused' && <span className="offline">{t('status.refused')}</span>}
      <span className={outboxCount > 0 ? 'waiting' : undefined}>
        {t('status.waiting', { count: outboxCount })}
      </span>
      <span>
        {lastSyncAt ? t('status.lastSync', { time: time(new Date(lastSyncAt)) }) : t('status.neverSynced')}
      </span>
      <span className="user">{userName ?? t('status.locked')}</span>
    </footer>
  );
}
