import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';

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

/** Counters (POS spec §4, W0-10): one-time setup codes, and the list of counters with revoke. */
export function CountersScreen({ api }: { api: Api }) {
  const { t, i18n } = useTranslation();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [branchId, setBranchId] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('counter');
  const [name, setName] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [confirming, setConfirming] = useState<Device | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    const r = await api('POST', '/api/devices/enrollment-codes', {
      branchId,
      kind,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    if (r.status === 201) setCode(r.body as { code: string; expiresAt: string });
    else setMessage(t('app.error'));
  };

  const revoke = async (d: Device) => {
    const r = await api('POST', `/api/devices/${d.id}/revoke`);
    setConfirming(null);
    setMessage(r.status === 204 ? t('counters.revoked', { code: d.code }) : t('app.error'));
    await load();
  };

  return (
    <main className="screen">
      <h1>{t('counters.title')}</h1>
      <p>{t('counters.help')}</p>
      <form onSubmit={(e) => void create(e)} className="inline-form">
        <label>
          {t('counters.branch')}
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('counters.kind')}
          <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`counters.kinds.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('counters.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </label>
        <button type="submit" disabled={!branchId}>
          {t('counters.create')}
        </button>
      </form>
      {code && (
        <p role="status" className="code">
          {t('counters.codeShown', { time: time(code.expiresAt) })} <strong>{code.code}</strong>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {devices === null ? (
        <p>{t('app.loading')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('counters.code')}</th>
              <th>{t('counters.kind')}</th>
              <th>{t('counters.enrolled')}</th>
              <th>{t('counters.status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.code}</td>
                <td>{t(`counters.kinds.${d.kind}`)}</td>
                <td>{time(d.enrolledAt)}</td>
                <td>{t(`counters.statuses.${d.status}`)}</td>
                <td>
                  {d.status === 'active' &&
                    (confirming?.id === d.id ? (
                      <button type="button" className="danger" onClick={() => void revoke(d)}>
                        {t('counters.confirmRevoke')}
                      </button>
                    ) : (
                      <button type="button" onClick={() => setConfirming(d)}>
                        {t('counters.revoke')}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
