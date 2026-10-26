import type { RoleAssignment, UserSummary } from '@erp/contracts';
import { Alert, AlertDescription, Button, PageHeader, Panel, StatusChip, TextField } from '@erp/ui';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { refusalText, useStaffData } from './data';
import { ConfirmDialog, PasswordDialog, RolePicker, TemporaryPinDialog } from './dialogs';
import { accessChip, pinChip } from './StaffScreen';

// One person (W1-04): details, roles and branch, back-office password, counter PIN, deactivate. Managers see only the
// PIN; everything else needs admin.users.

type Dialog = 'pin' | 'password' | 'removePassword' | 'deactivate' | 'reactivate' | null;

export function PersonScreen({
  api,
  id,
  permissions,
}: {
  api: Api;
  id: string;
  permissions: readonly string[];
}) {
  const { t } = useTranslation();
  const canAdmin = permissions.includes('admin.users');
  const { users, roles, branches, reload } = useStaffData(api, canAdmin);
  const person = users?.find((u) => u.id === id) ?? null;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const back = (
    <a
      href={href.staff}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('staff.back')}
    </a>
  );
  if (users === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (!person) return <PageHeader eyebrow={back} title={t('staff.notFound')} />;

  const done = (text: string) => {
    setDialog(null);
    setMessage({ text, error: false });
    void reload();
  };
  const name = person.fullName;
  const active = person.status === 'active';
  const pin = pinChip(t, person);
  const access = accessChip(t, person);

  return (
    <>
      <PageHeader
        eyebrow={back}
        title={name}
        help={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{person.username}</span>
            <StatusChip tone={active ? 'ok' : 'bad'}>{t(`staff.statuses.${person.status}`)}</StatusChip>
          </span>
        }
        actions={
          canAdmin &&
          (active ? (
            <Button variant="outline" onClick={() => setDialog('deactivate')}>
              {t('staff.deactivate')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setDialog('reactivate')}>
              {t('staff.reactivate')}
            </Button>
          ))
        }
      />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-2.5 lg:grid-cols-2">
        {canAdmin && (
          <DetailsPanel
            key={`${person.fullName}|${person.shortCode}|${person.email}`}
            api={api}
            person={person}
            onSaved={() => done(t('staff.detailsSaved'))}
          />
        )}
        {canAdmin && (
          <RolesPanel
            // A reload after saving brings the server's view: start again from it.
            key={JSON.stringify(person.roles)}
            api={api}
            person={person}
            roles={roles}
            branches={branches}
            onSaved={() => done(t('staff.rolesSaved'))}
            onError={(text) => setMessage({ text, error: true })}
          />
        )}
        {canAdmin && (
          <Panel title={t('staff.password.title')}>
            <div className="flex flex-col gap-3 px-3.5 pb-3.5">
              <p className="m-0 flex flex-wrap items-center gap-2">
                <StatusChip tone={access.tone}>{access.text}</StatusChip>
                {t(person.hasPassword ? 'staff.password.has' : 'staff.password.none', { name })}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setDialog('password')}>
                  {person.hasPassword ? t('staff.password.reset') : t('staff.password.give')}
                </Button>
                {person.hasPassword && (
                  <Button variant="outline" onClick={() => setDialog('removePassword')}>
                    {t('staff.password.remove')}
                  </Button>
                )}
              </div>
            </div>
          </Panel>
        )}
        <Panel title={t('staff.pinTitle')}>
          <div className="flex flex-col gap-3 px-3.5 pb-3.5">
            <p className="m-0">
              <StatusChip tone={pin.tone}>{pin.text}</StatusChip>
            </p>
            <p className="m-0 text-muted-foreground">{t('staff.pinHelp')}</p>
            {active && person.canGivePin && (
              <div>
                <Button variant="outline" onClick={() => setDialog('pin')}>
                  {t('staff.give')}
                </Button>
              </div>
            )}
          </div>
        </Panel>
      </div>

      <TemporaryPinDialog
        api={api}
        person={dialog === 'pin' ? person : null}
        onOpenChange={(o) => !o && setDialog(null)}
        onSaved={() => done(t('staff.saved', { name }))}
      />
      {canAdmin && (
        <>
          <PasswordDialog
            api={api}
            person={person}
            open={dialog === 'password'}
            onOpenChange={(o) => !o && setDialog(null)}
            onSaved={() => done(t('staff.password.saved', { name }))}
          />
          <ConfirmDialog
            api={api}
            open={dialog === 'removePassword'}
            onOpenChange={(o) => !o && setDialog(null)}
            title={t('staff.password.remove')}
            text={t('staff.password.removeConfirm', { name })}
            actionLabel={t('staff.password.remove')}
            call={['DELETE', `/api/users/${person.id}/password`]}
            onDone={() => done(t('staff.password.removed', { name }))}
          />
          <ConfirmDialog
            api={api}
            open={dialog === 'deactivate'}
            onOpenChange={(o) => !o && setDialog(null)}
            title={t('staff.deactivate')}
            text={t('staff.deactivateConfirm', { name })}
            actionLabel={t('staff.deactivate')}
            call={['POST', `/api/users/${person.id}/deactivate`]}
            onDone={() => done(t('staff.deactivated', { name }))}
          />
          <ConfirmDialog
            api={api}
            open={dialog === 'reactivate'}
            onOpenChange={(o) => !o && setDialog(null)}
            title={t('staff.reactivate')}
            text={t('staff.reactivateConfirm', { name })}
            actionLabel={t('staff.reactivate')}
            call={['POST', `/api/users/${person.id}/reactivate`]}
            onDone={() => done(t('staff.reactivated', { name }))}
          />
        </>
      )}
    </>
  );
}

function DetailsPanel({ api, person, onSaved }: { api: Api; person: UserSummary; onSaved: () => void }) {
  const { t, i18n } = useTranslation();
  const [fullName, setFullName] = useState(person.fullName);
  const [shortCode, setShortCode] = useState(person.shortCode ?? '');
  const [email, setEmail] = useState(person.email ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api('PATCH', `/api/users/${person.id}`, {
      fullName: fullName.trim(),
      shortCode: shortCode.trim() || null,
      email: email.trim() || null,
    });
    setBusy(false);
    if (r.status === 204) return onSaved();
    setError(refusalText(t, (k) => i18n.exists(k), r.body));
  };

  return (
    <Panel title={t('staff.details')}>
      <form className="flex flex-col gap-3 px-3.5 pb-3.5" onSubmit={(e) => void save(e)}>
        <TextField
          label={t('staff.fullName')}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          maxLength={120}
        />
        <TextField
          label={t('staff.shortCodeField')}
          value={shortCode}
          onChange={(e) => setShortCode(e.target.value)}
          maxLength={8}
          className="font-mono"
        />
        <TextField
          label={t('staff.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={254}
          error={error ?? undefined}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {t('staff.saveDetails')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function RolesPanel({
  api,
  person,
  roles,
  branches,
  onSaved,
  onError,
}: {
  api: Api;
  person: UserSummary;
  roles: Parameters<typeof RolePicker>[0]['roles'];
  branches: Parameters<typeof RolePicker>[0]['branches'];
  onSaved: () => void;
  onError: (text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const held = (): RoleAssignment[] => person.roles.map((r) => ({ roleId: r.roleId, branchId: r.branchId }));
  const [value, setValue] = useState<RoleAssignment[]>(held);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await api('PUT', `/api/users/${person.id}/roles`, { roles: value });
    setBusy(false);
    if (r.status === 204) return onSaved();
    onError(refusalText(t, (k) => i18n.exists(k), r.body));
  };

  return (
    <Panel title={t('staff.roles')}>
      <div className="flex flex-col gap-3 px-3.5 pb-3.5">
        <RolePicker roles={roles} branches={branches} value={value} onChange={setValue} />
        <div>
          <Button onClick={() => void save()} disabled={busy}>
            {t('staff.saveRoles')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
