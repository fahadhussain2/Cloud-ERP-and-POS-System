import {
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
import { Ban, Download, KeyRound, RotateCcw, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { DiagnosticsRow } from '@erp/contracts';

import type { Api } from '../api';
import { ConfirmDialog } from '../staff/dialogs';
import { Button, IconButton, notify, Select, TextInput } from '../ui';

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

/**
 * Counters (POS spec §4, W0-10): one-time setup codes, and the list of counters with revoke. Restyled in W1-04, and
 * on the back office's own controls in W2-15 (D-127): icon row actions, results and refusals as toasts.
 */
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
  const [looking, setLooking] = useState<Device | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);

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
    const r = await api('POST', '/api/devices/enrollment-codes', {
      branchId,
      kind,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    if (r.status === 201) setCode(r.body as { code: string; expiresAt: string });
    else notify.problem(t('app.error'));
  };

  return (
    <>
      <PageHeader title={t('counters.title')} help={t('counters.help')} />
      <Panel title={t('counters.newCode')}>
        <form className="flex flex-wrap items-end gap-3 px-3.5 pb-3.5" onSubmit={(e) => void create(e)}>
          <Select
            label={t('counters.branch')}
            wrapperClassName="w-full sm:w-56"
            value={branchId}
            onValueChange={setBranchId}
            options={branches.map((b) => ({ value: b.id, label: b.name }))}
          />
          <Select
            label={t('counters.kind')}
            wrapperClassName="w-full sm:w-48"
            value={kind}
            onValueChange={(v) => setKind(v as (typeof KINDS)[number])}
            options={KINDS.map((k) => ({ value: k, label: t(`counters.kinds.${k}`) }))}
          />
          <TextInput
            label={t('counters.name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            wrapperClassName="w-full sm:w-56"
          />
          <Button type="submit" icon={KeyRound} disabled={!branchId}>
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
      <Panel title={t('counters.list')}>
        {devices === null ? (
          <p className="px-3.5 pb-3.5 text-muted-foreground">{t('app.loading')}</p>
        ) : (
          <div className="overflow-x-auto px-1.5 pb-2.5">
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
                    <TableCell className="w-0">
                      <span className="flex justify-end gap-0.5">
                        <IconButton
                          icon={Stethoscope}
                          label={`${t('counters.diagnostics.show')} ${d.code}`}
                          aria-pressed={looking?.id === d.id}
                          onClick={() => setLooking(looking?.id === d.id ? null : d)}
                        />
                        {d.status === 'active' ? (
                          <IconButton
                            icon={Ban}
                            tone="danger"
                            label={`${t('counters.revoke')} ${d.code}`}
                            onClick={() => setRevoking(d)}
                          />
                        ) : (
                          <IconButton
                            icon={RotateCcw}
                            label={`${t('counters.reenable')} ${d.code}`}
                            onClick={() => setReenabling(d)}
                          />
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
      {looking && <DiagnosticsPanel key={looking.id} api={api} device={looking} time={time} />}
      {revoking && (
        <ConfirmDialog
          api={api}
          open
          onOpenChange={(o) => !o && setRevoking(null)}
          title={t('counters.confirmTitle', { code: revoking.code })}
          text={t('counters.confirmHelp')}
          actionLabel={t('counters.confirmRevoke')}
          call={['POST', `/api/devices/${revoking.id}/revoke`]}
          tone="danger"
          onDone={() => {
            notify.done(t('counters.revoked', { code: revoking.code }));
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
            notify.done(t('counters.reenabled', { code: reenabling.code }));
            setReenabling(null);
            void load();
          }}
        />
      )}
    </>
  );
}

/**
 * What a manager sent from this counter with Send diagnostics (PLT-12, owner answer 6 to W1-20): kept 30 days; each one
 * downloads as JSON for support.
 */
function DiagnosticsPanel({
  api,
  device,
  time,
}: {
  api: Api;
  device: Device;
  time: (iso: string) => string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<DiagnosticsRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/devices/${encodeURIComponent(device.id)}/diagnostics`).then((r) => {
      if (live) setRows(r.status === 200 ? (r.body as { diagnostics: DiagnosticsRow[] }).diagnostics : []);
    });
    return () => {
      live = false;
    };
  }, [api, device.id]);
  const download = async (row: DiagnosticsRow) => {
    const r = await api(
      'GET',
      `/api/devices/${encodeURIComponent(device.id)}/diagnostics/${encodeURIComponent(row.id)}`,
    );
    if (r.status !== 200) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(r.body, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagnostics-${device.code}-${row.receivedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel title={`${t('counters.diagnostics.title')} · ${device.code}`} className="pb-2">
      <p className="m-0 px-3.5 text-sm text-muted-foreground">{t('counters.diagnostics.help')}</p>
      {rows === null ? null : rows.length === 0 ? (
        <p className="m-0 px-3.5 pt-2 text-muted-foreground">{t('counters.diagnostics.none')}</p>
      ) : (
        <Table aria-label={t('counters.diagnostics.title')}>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{time(row.receivedAt)}</TableCell>
                <TableCell>
                  {t('counters.diagnostics.sentBy')} {row.sentByName}
                </TableCell>
                <TableCell>{t('counters.diagnostics.events', { count: row.eventCount })}</TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="outline" icon={Download} onClick={() => void download(row)}>
                    {t('counters.diagnostics.download')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
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
