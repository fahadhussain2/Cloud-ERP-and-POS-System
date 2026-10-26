import type { UserSummary } from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Button,
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
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { useStaffData } from './data';
import { AddPersonDialog, TemporaryPinDialog } from './dialogs';

// Staff (W1-04, owner answer 2): one list of the shop's people. With admin.users you add and change people; with
// admin.devices (managers) you give temporary PINs (D-089).

export const pinChip = (t: TFunction, u: UserSummary): { tone: ChipTone; text: string } =>
  !u.hasPin
    ? { tone: 'neutral', text: t('staff.pin.none') }
    : u.pinMustChange
      ? { tone: 'warn', text: t('staff.pin.temporary') }
      : { tone: 'ok', text: t('staff.pin.set') };

export const accessChip = (t: TFunction, u: UserSummary): { tone: ChipTone; text: string } =>
  u.hasPassword
    ? { tone: 'accent', text: t('staff.backOfficeYes') }
    : { tone: 'neutral', text: t('staff.backOfficeNo') };

export function StaffScreen({ api, permissions }: { api: Api; permissions: readonly string[] }) {
  const { t } = useTranslation();
  const canAdmin = permissions.includes('admin.users');
  const canPin = permissions.includes('admin.devices') || canAdmin;
  const { users, roles, branches, reload } = useStaffData(api, canAdmin);
  const [filter, setFilter] = useState<'active' | 'disabled'>('active');
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<UserSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const shown = (users ?? []).filter((u) => u.status === filter);

  return (
    <>
      <PageHeader
        title={t('staff.title')}
        help={t('staff.help')}
        actions={
          canAdmin && (
            <Button size="lg" onClick={() => setAdding(true)}>
              {t('staff.add')}
            </Button>
          )
        }
      />
      {message && (
        <Alert>
          <AlertDescription role="status">{message}</AlertDescription>
        </Alert>
      )}
      <Panel>
        <div className="flex flex-wrap gap-1.5 px-3.5 pt-3 pb-2" role="group" aria-label={t('staff.status')}>
          {(['active', 'disabled'] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? 'default' : 'outline'}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`staff.filter.${f}`)}
            </Button>
          ))}
        </div>
        {users === null ? (
          <p className="px-3.5 pb-3.5 text-muted-foreground">{t('app.loading')}</p>
        ) : shown.length === 0 ? (
          <p className="px-3.5 pb-3.5 text-muted-foreground">{t('staff.empty')}</p>
        ) : (
          <div className="px-1.5 pb-2.5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('staff.name')}</TableHead>
                  <TableHead>{t('staff.shortCode')}</TableHead>
                  <TableHead>{t('staff.roles')}</TableHead>
                  <TableHead>{t('staff.backOffice')}</TableHead>
                  <TableHead>{t('staff.pinState')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('staff.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((u) => {
                  const pin = pinChip(t, u);
                  const access = accessChip(t, u);
                  return (
                    <TableRow key={u.id}>
                      <TableCell>
                        <a
                          href={href.person(u.id)}
                          className="font-semibold text-ink underline-offset-4 hover:underline"
                        >
                          {u.fullName}
                        </a>
                        <span className="block font-mono text-xs text-muted-foreground">{u.username}</span>
                      </TableCell>
                      <TableCell className="font-mono">{u.shortCode}</TableCell>
                      <TableCell>{u.roles.map((r) => r.name).join(', ') || t('staff.noRoles')}</TableCell>
                      <TableCell>
                        <StatusChip tone={access.tone}>{access.text}</StatusChip>
                      </TableCell>
                      <TableCell>
                        <StatusChip tone={pin.tone}>{pin.text}</StatusChip>
                      </TableCell>
                      <TableCell className="text-end">
                        {canPin && u.status === 'active' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setMessage(null);
                              setPinFor(u);
                            }}
                          >
                            {t('staff.give')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      {canAdmin && (
        <AddPersonDialog
          api={api}
          roles={roles}
          branches={branches}
          open={adding}
          onOpenChange={setAdding}
          onAdded={(name) => {
            setAdding(false);
            setMessage(t('staff.created', { name }));
            void reload();
          }}
        />
      )}
      <TemporaryPinDialog
        api={api}
        person={pinFor}
        onOpenChange={(o) => !o && setPinFor(null)}
        onSaved={(name) => {
          setPinFor(null);
          setMessage(t('staff.saved', { name }));
          void reload();
        }}
      />
    </>
  );
}
