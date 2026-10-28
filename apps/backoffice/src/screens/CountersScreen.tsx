import {
  Alert,
  AlertDescription,
  Button,
  LABEL_CLASS,
  Label,
  PageHeader,
  Panel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextField,
  type ChipTone,
} from '@erp/ui';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { ConfirmDialog } from '../staff/dialogs';

interface Branch {
  id: string;
  code: string;
  name: string;
}

interface Device {
  id: string;
  code: string;
  name: string | null;
  kind: string;
  branchId: string;
  status: string;
  enrolledAt: string;
  revokedAt: string | null;
  /** From the counter's last push and pull (PLT-09, W1-07); null before it has called in. */
  health: DeviceHealth | null;
}

interface DeviceHealth {
  lastSeenAt: string | null;
  clientVersion: string | null;
  outboxCount: number | null;
  oldestUnsyncedAt: string | null;
  quarantinedCount: number | null;
  storagePersisted: boolean | null;
  clockSkewMs: number | null;
  openGaps: number;
}

const KINDS = ['counter', 'cash_desk', 'mobile'] as const;
const MINUTE = 60_000;

/**
 * When a counter's figures need someone's eye (W1-07 plan, architecture §11.6): bills waiting over 10 minutes amber,
 * over 4 hours red; a clock over 5 minutes off; storage the browser may clear; a missing bill number.
 */
export function healthTones(h: DeviceHealth, nowMs: number) {
  const age = h.oldestUnsyncedAt === null ? 0 : nowMs - Date.parse(h.oldestUnsyncedAt);
  const waiting: ChipTone =
    (h.outboxCount ?? 0) === 0 ? 'ok' : age > 240 * MINUTE ? 'bad' : age > 10 * MINUTE ? 'warn' : 'neutral';
  return {
    waiting,
    clock: (h.clockSkewMs !== null && Math.abs(h.clockSkewMs) > 5 * MINUTE ? 'bad' : 'ok') as ChipTone,
    storage: (h.storagePersisted === false ? 'bad' : 'ok') as ChipTone,
    gaps: (h.openGaps > 0 ? 'bad' : 'ok') as ChipTone,
  };
}

/** Counters (POS spec §4, W0-10): one-time setup codes, and the list of counters with revoke. Restyled in W1-04. */
export function CountersScreen({ api }: { api: Api }) {
  const { t, i18n } = useTranslation();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [branchId, setBranchId] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('counter');
  const [name, setName] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [reenabling, setReenabling] = useState<Device | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const branchLabel = useId();
  const kindLabel = useId();

  const fetchLists = useCallback(async () => {
    const [b, d] = await Promise.all([api('GET', '/api/branches'), api('GET', '/api/devices')]);
    return {
      branches: b.status === 200 ? (b.body as Branch[]) : [],
      devices: d.status === 200 ? (d.body as Device[]) : [],
    };
  }, [api]);
  const show = useCallback((lists: { branches: Branch[]; devices: Device[] }) => {
    setBranches(lists.branches);
    setBranchId((id) => id || (lists.branches[0]?.id ?? ''));
    setDevices(lists.devices);
    setLoadedAt(Date.now());
  }, []);
  const load = async () => show(await fetchLists());

  useEffect(() => {
    let live = true;
    void fetchLists().then((lists) => live && show(lists));
    return () => {
      live = false;
    };
  }, [fetchLists, show]);

  const time = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const r = await api('POST', '/api/devices/enrollment-codes', {
      branchId,
      kind,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    if (r.status === 201) setCode(r.body as { code: string; expiresAt: string });
    else setMessage({ text: t('app.error'), error: true });
  };

  return (
    <>
      <PageHeader title={t('counters.title')} help={t('counters.help')} />
      <Panel title={t('counters.newCode')}>
        <form className="flex flex-wrap items-end gap-3 px-3.5 pb-3.5" onSubmit={(e) => void create(e)}>
          <div className="flex flex-col gap-1.5">
            <Label id={branchLabel} className={LABEL_CLASS}>
              {t('counters.branch')}
            </Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger aria-labelledby={branchLabel} className="h-11 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label id={kindLabel} className={LABEL_CLASS}>
              {t('counters.kind')}
            </Label>
            <Select value={kind} onValueChange={(v) => setKind(v as (typeof KINDS)[number])}>
              <SelectTrigger aria-labelledby={kindLabel} className="h-11 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`counters.kinds.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <TextField
            label={t('counters.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            wrapperClassName="w-56"
          />
          <Button type="submit" size="lg" disabled={!branchId}>
            {t('counters.create')}
          </Button>
        </form>
        {code && (
          <div role="status" className="mx-3.5 mb-3.5 rounded-lg bg-ok-soft px-3.5 py-3 text-ok">
            <p className="m-0">{t('counters.codeShown', { time: time(code.expiresAt) })}</p>
            <strong className="font-mono text-3xl tracking-[.1em] text-ink">{code.code}</strong>
          </div>
        )}
      </Panel>
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <Panel title={t('counters.list')}>
        {devices === null ? (
          <p className="px-3.5 pb-3.5 text-muted-foreground">{t('app.loading')}</p>
        ) : (
          <div className="px-1.5 pb-2.5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('counters.code')}</TableHead>
                  <TableHead>{t('counters.kind')}</TableHead>
                  <TableHead>{t('counters.enrolled')}</TableHead>
                  <TableHead>{t('counters.status')}</TableHead>
                  <TableHead>{t('counters.lastSeen')}</TableHead>
                  <TableHead>{t('counters.waiting')}</TableHead>
                  <TableHead>{t('counters.app')}</TableHead>
                  <TableHead>{t('counters.clock')}</TableHead>
                  <TableHead>{t('counters.storage')}</TableHead>
                  <TableHead>{t('counters.gaps')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('staff.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono font-semibold">{d.code}</TableCell>
                    <TableCell>{t(`counters.kinds.${d.kind}`)}</TableCell>
                    <TableCell>{time(d.enrolledAt)}</TableCell>
                    <TableCell>
                      <StatusChip tone={d.status === 'active' ? 'ok' : 'bad'}>
                        {t(`counters.statuses.${d.status}`)}
                      </StatusChip>
                    </TableCell>
                    <HealthCells health={d.health ?? null} time={time} nowMs={loadedAt} />
                    <TableCell className="text-end">
                      {d.status === 'active' ? (
                        <Button size="sm" variant="outline" onClick={() => setRevoking(d)}>
                          {t('counters.revoke')}
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setReenabling(d)}>
                          {t('counters.reenable')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
      {revoking && (
        <ConfirmDialog
          api={api}
          open
          onOpenChange={(o) => !o && setRevoking(null)}
          title={t('counters.confirmTitle', { code: revoking.code })}
          text={t('counters.confirmHelp')}
          actionLabel={t('counters.confirmRevoke')}
          call={['POST', `/api/devices/${revoking.id}/revoke`]}
          onDone={() => {
            setMessage({ text: t('counters.revoked', { code: revoking.code }), error: false });
            setRevoking(null);
            void load();
          }}
        />
      )}
      {reenabling && (
        <ConfirmDialog
          api={api}
          open
          onOpenChange={(o) => !o && setReenabling(null)}
          title={t('counters.confirmReenableTitle', { code: reenabling.code })}
          text={t('counters.confirmReenableHelp')}
          actionLabel={t('counters.confirmReenable')}
          call={['POST', `/api/devices/${reenabling.id}/reenable`]}
          onDone={() => {
            setMessage({ text: t('counters.reenabled', { code: reenabling.code }), error: false });
            setReenabling(null);
            void load();
          }}
        />
      )}
    </>
  );
}

/** A counter's health on its row (PLT-09): as of its last contact, with the figures that need an eye coloured. */
function HealthCells({
  health,
  time,
  nowMs,
}: {
  health: DeviceHealth | null;
  time: (iso: string) => string;
  /** When the list was loaded: the figures are as of then. */
  nowMs: number;
}) {
  const { t, i18n } = useTranslation();
  if (health === null)
    return (
      <>
        <TableCell className="text-muted-foreground">{t('counters.notSeen')}</TableCell>
        {[1, 2, 3, 4, 5].map((i) => (
          <TableCell key={i} className="text-muted-foreground">
            –
          </TableCell>
        ))}
      </>
    );
  const tones = healthTones(health, nowMs);
  const waiting = health.outboxCount ?? 0;
  const refused = health.quarantinedCount ?? 0;
  const skewMin = Math.round(Math.abs(health.clockSkewMs ?? 0) / MINUTE);
  const count = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  return (
    <>
      <TableCell>{health.lastSeenAt ? time(health.lastSeenAt) : t('counters.notSeen')}</TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          <StatusChip tone={tones.waiting}>
            {waiting === 0 || health.oldestUnsyncedAt === null
              ? t('counters.waitingNone')
              : t('counters.waitingSince', { count: count(waiting), time: time(health.oldestUnsyncedAt) })}
          </StatusChip>
          {refused > 0 && <StatusChip tone="bad">{t('counters.attention', { count: refused })}</StatusChip>}
        </span>
      </TableCell>
      <TableCell className="font-mono">{health.clientVersion ?? '–'}</TableCell>
      <TableCell>
        <StatusChip tone={tones.clock}>
          {tones.clock === 'bad' ? t('counters.clockOff', { minutes: skewMin }) : t('counters.clockOk')}
        </StatusChip>
      </TableCell>
      <TableCell>
        <StatusChip tone={tones.storage}>
          {tones.storage === 'bad' ? t('counters.storageBad') : t('counters.storageOk')}
        </StatusChip>
      </TableCell>
      <TableCell>
        <StatusChip tone={tones.gaps}>
          {health.openGaps > 0 ? t('counters.gapsOpen', { count: health.openGaps }) : t('counters.gapsNone')}
        </StatusChip>
      </TableCell>
    </>
  );
}
