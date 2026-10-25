import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';

interface Staff {
  id: string;
  username: string;
  fullName: string;
  shortCode: string | null;
  status: string;
  hasPin: boolean;
  pinMustChange: boolean;
}

/** Staff PINs (owner answer 2 to W1-02): a manager gives a temporary PIN; the person chooses their own at the counter. */
export function StaffPinsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const fetchStaff = useCallback(async () => {
    const r = await api('GET', '/api/staff');
    return r.status === 200 ? (r.body as Staff[]) : [];
  }, [api]);
  const load = async () => setStaff(await fetchStaff());

  useEffect(() => {
    let live = true;
    void fetchStaff().then((s) => live && setStaff(s));
    return () => {
      live = false;
    };
  }, [fetchStaff]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const r = await api('PUT', `/api/users/${editing.id}/temporary-pin`, { pin });
    setPin('');
    if (r.status === 204) {
      setMessage({ text: t('staff.saved', { name: editing.fullName }), error: false });
      setEditing(null);
      return load();
    }
    setMessage({ text: r.status === 400 ? t('staff.weak_pin') : t('app.error'), error: true });
  };

  const pinState = (s: Staff) =>
    !s.hasPin ? t('staff.pin.none') : s.pinMustChange ? t('staff.pin.temporary') : t('staff.pin.set');

  return (
    <main className="screen">
      <h1>{t('staff.title')}</h1>
      <p>{t('staff.help')}</p>
      {message && <p role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {editing && (
        <form onSubmit={(e) => void save(e)} className="inline-form">
          <h2>{editing.fullName}</h2>
          <label>
            {t('staff.temporaryPin')}
            <input
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
            />
          </label>
          <button type="submit">{t('staff.save')}</button>
          <button type="button" onClick={() => setEditing(null)}>
            {t('staff.cancel')}
          </button>
        </form>
      )}
      {staff === null ? (
        <p>{t('app.loading')}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('staff.name')}</th>
              <th>{t('staff.shortCode')}</th>
              <th>{t('staff.pinState')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>{s.fullName}</td>
                <td>{s.shortCode}</td>
                <td>{pinState(s)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(s);
                      setMessage(null);
                    }}
                  >
                    {t('staff.give')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
