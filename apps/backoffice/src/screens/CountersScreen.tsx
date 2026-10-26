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
}

const KINDS = ['counter', 'cash_desk', 'mobile'] as const;

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
                    <TableCell className="text-end">
                      {d.status === 'active' && (
                        <Button size="sm" variant="outline" onClick={() => setRevoking(d)}>
                          {t('counters.revoke')}
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
    </>
  );
}
