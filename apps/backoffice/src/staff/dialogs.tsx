import type { RoleAssignment, RoleSummary } from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  LABEL_CLASS,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextField,
} from '@erp/ui';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { ALL_BRANCHES, branchFromValue, branchValue, refusalText, toggleRole, type Branch } from './data';

// The Staff dialogs (W1-04). Each ends with the D-053 bar: Cancel (Esc) and a main button named after its action.

/** A dialog around a form: title, optional text, the fields, the D-053 bar. */
function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  busy,
  onSubmit,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  actionLabel: string;
  busy: boolean;
  onSubmit: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  // These dialogs open from state, not a DialogTrigger, so Radix can't know where focus came from: remember it and
  // give it back on close (D-053: Esc returns you where you were).
  const opener = useRef<HTMLElement | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="bg-surface"
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(e) => {
          if (!opener.current?.isConnected) return;
          e.preventDefault();
          opener.current.focus();
        }}
      >
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogActions cancelLabel={t('staff.cancel')} actionLabel={actionLabel} busy={busy} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/** Calls the API and reports the outcome: `ok` on the expected status, or the refusal's words. */
function useSubmit(api: Api) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (
    call: Parameters<Api>,
    okStatus: number,
    ok: (body: unknown) => void,
    words: (body: unknown) => string | null = () => null,
  ) => {
    setBusy(true);
    setError(null);
    const r = await api(...call);
    setBusy(false);
    if (r.status === okStatus) return ok(r.body);
    setError(words(r.body) ?? refusalText(t, (k) => i18n.exists(k), r.body));
  };
  return { busy, error, setError, submit };
}

/** Role checkboxes, and the branch that newly checked roles are for (Delux has one branch: "All branches"). */
export function RolePicker({
  roles,
  branches,
  value,
  onChange,
}: {
  roles: readonly RoleSummary[];
  branches: readonly Branch[];
  value: readonly RoleAssignment[];
  onChange: (next: RoleAssignment[]) => void;
}) {
  const { t } = useTranslation();
  const [branch, setBranch] = useState<string | null>(null);
  const branchLabelId = useId();
  const branchName = (id: string | null) =>
    id === null ? t('staff.allBranches') : (branches.find((b) => b.id === id)?.name ?? id);
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className={LABEL_CLASS}>{t('staff.roles')}</legend>
      <p className="m-0 text-xs text-muted-foreground">{t('staff.rolesHelp')}</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {roles.map((r) => {
          const held = value.filter((a) => a.roleId === r.id);
          return (
            <label key={r.id} className="flex items-center gap-2 font-medium">
              <Checkbox
                checked={held.length > 0}
                onCheckedChange={(on) => onChange(toggleRole(value, r.id, on === true, branch))}
              />
              {r.name}
              {held.some((a) => a.branchId !== null) && (
                <span className="text-xs text-muted-foreground">
                  {held.map((a) => branchName(a.branchId)).join(', ')}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label id={branchLabelId} className={LABEL_CLASS}>
          {t('staff.branchForNew')}
        </Label>
        <Select value={branchValue(branch)} onValueChange={(v) => setBranch(branchFromValue(v))}>
          <SelectTrigger aria-labelledby={branchLabelId} className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_BRANCHES}>{t('staff.allBranches')}</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </fieldset>
  );
}

/** Add a person: details, roles, and a temporary password only if they need the back office. */
export function AddPersonDialog({
  api,
  roles,
  branches,
  open,
  onOpenChange,
  onAdded,
}: {
  api: Api;
  roles: readonly RoleSummary[];
  branches: readonly Branch[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (fullName: string) => void;
}) {
  const { t } = useTranslation();
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [assignments, setAssignments] = useState<RoleAssignment[]>([]);
  const { busy, error, setError, submit } = useSubmit(api);

  const reset = () => {
    setFullName('');
    setUsername('');
    setShortCode('');
    setEmail('');
    setPassword('');
    setAssignments([]);
    setError(null);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={t('staff.add')}
      actionLabel={t('staff.create')}
      busy={busy}
      onSubmit={() =>
        void submit(
          [
            'POST',
            '/api/users',
            {
              username: username.trim(),
              fullName: fullName.trim(),
              shortCode: shortCode.trim() || null,
              email: email.trim() || null,
              roles: assignments,
              ...(password ? { temporaryPassword: password } : {}),
            },
          ],
          201,
          () => {
            const name = fullName.trim();
            reset();
            onAdded(name);
          },
        )
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label={t('staff.fullName')}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          maxLength={120}
        />
        <TextField
          label={t('staff.username')}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          maxLength={64}
          autoComplete="off"
          className="font-mono"
        />
        <TextField
          label={t('staff.shortCodeField')}
          value={shortCode}
          onChange={(e) => setShortCode(e.target.value)}
          maxLength={8}
          autoComplete="off"
          className="font-mono"
        />
        <TextField
          label={t('staff.email')}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={254}
        />
        <TextField
          label={t('staff.password.optional')}
          hint={t('staff.password.optionalHelp')}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          wrapperClassName="sm:col-span-2"
        />
      </div>
      <RolePicker roles={roles} branches={branches} value={assignments} onChange={setAssignments} />
      <ErrorLine text={error} />
    </FormDialog>
  );
}

/** A manager or the owner gives a temporary PIN; the person chooses their own at the counter (D-089). */
export function TemporaryPinDialog({
  api,
  person,
  onOpenChange,
  onSaved,
}: {
  api: Api;
  person: { id: string; fullName: string } | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (fullName: string) => void;
}) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const { busy, error, setError, submit } = useSubmit(api);
  return (
    <FormDialog
      open={person !== null}
      onOpenChange={(o) => {
        if (!o) {
          setPin('');
          setError(null);
        }
        onOpenChange(o);
      }}
      title={t('staff.give')}
      description={person?.fullName}
      actionLabel={t('staff.save')}
      busy={busy}
      onSubmit={() =>
        person &&
        void submit(
          ['PUT', `/api/users/${person.id}/temporary-pin`, { pin }],
          204,
          () => {
            setPin('');
            onSaved(person.fullName);
          },
          (b) => {
            const error = (b as { error?: string } | null)?.error;
            if (error === 'weak_pin') return t('staff.weak_pin');
            if (error === 'cannot_grant') return t('staff.errors.pin_not_allowed');
            return null;
          },
        )
      }
    >
      <TextField
        label={t('staff.temporaryPin')}
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        required
        maxLength={6}
        className="font-mono tracking-[.3em]"
      />
      <ErrorLine text={error} />
    </FormDialog>
  );
}

/** Gives or resets a back-office password: a temporary one the person replaces at their first sign-in (D-083). */
export function PasswordDialog({
  api,
  person,
  open,
  onOpenChange,
  onSaved,
}: {
  api: Api;
  person: { id: string; fullName: string; hasPassword: boolean };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const { busy, error, setError, submit } = useSubmit(api);
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPassword('');
          setError(null);
        }
        onOpenChange(o);
      }}
      title={person.hasPassword ? t('staff.password.reset') : t('staff.password.give')}
      description={t('staff.password.temporaryHelp')}
      actionLabel={t('staff.password.save')}
      busy={busy}
      onSubmit={() =>
        void submit(['PUT', `/api/users/${person.id}/password`, { temporaryPassword: password }], 204, () => {
          setPassword('');
          onSaved();
        })
      }
    >
      <TextField
        label={t('staff.password.temporary')}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      <ErrorLine text={error} />
    </FormDialog>
  );
}

/** A yes/no question before something that can't be taken back quietly (deactivate, remove access, revoke). */
export function ConfirmDialog({
  api,
  open,
  onOpenChange,
  title,
  text,
  actionLabel,
  call,
  onDone,
}: {
  api: Api;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  text: ReactNode;
  actionLabel: string;
  call: Parameters<Api>;
  onDone: () => void;
}) {
  const { busy, error, setError, submit } = useSubmit(api);
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title={title}
      description={text}
      actionLabel={actionLabel}
      busy={busy}
      onSubmit={() => void submit(call, 204, onDone)}
    >
      <ErrorLine text={error} />
    </FormDialog>
  );
}
