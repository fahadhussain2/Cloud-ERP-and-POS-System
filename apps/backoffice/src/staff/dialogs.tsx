import type { RoleAssignment, RoleSummary } from '@erp/contracts';
import { Check, KeyRound, Save, UserPlus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { Checkbox, FIELD_LABEL, FormDialog, notify, Select, TextInput } from '../ui';
import { ALL_BRANCHES, branchFromValue, branchValue, refusalText, toggleRole, type Branch } from './data';

// The Staff dialogs (W1-04). Each ends with the D-053 bar: Cancel and a main button named after its action. W2-15
// (D-127): on the back office's own dialog; a refusal about one field shows at it, any other in a toast (owner
// answer 6).

/** A refusal's field, where it names one: a duplicate username, short code or email, a weak PIN or password. */
function fieldOf(body: unknown): string | null {
  const b = body as { error?: string; field?: string } | null;
  if (b?.error === 'duplicate' && b.field) return b.field;
  if (b?.error === 'weak_pin') return 'pin';
  if (b?.error === 'weak_password') return 'password';
  return null;
}

/** Calls the API and reports the outcome: `ok` on the expected status, else the refusal at its field or in a toast. */
function useSubmit(api: Api) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<Record<string, string | undefined>>({});
  const submit = async (
    call: Parameters<Api>,
    okStatus: number,
    ok: (body: unknown) => void,
    words: (body: unknown) => string | null = () => null,
  ) => {
    setBusy(true);
    setProblems({});
    const r = await api(...call);
    setBusy(false);
    if (r.status === okStatus) return ok(r.body);
    const text = words(r.body) ?? refusalText(t, (k) => i18n.exists(k), r.body);
    const field = fieldOf(r.body);
    if (field) setProblems({ [field]: text });
    else notify.problem(text);
  };
  /** Typing in a field clears its problem. */
  const clear = (field: string) => setProblems((p) => (p[field] ? { ...p, [field]: undefined } : p));
  return { busy, problems, setProblems, clear, submit };
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
  const branchName = (id: string | null) =>
    id === null ? t('staff.allBranches') : (branches.find((b) => b.id === id)?.name ?? id);
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className={FIELD_LABEL}>{t('staff.roles')}</legend>
      <p className="m-0 text-xs text-muted-foreground">{t('staff.rolesHelp')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {roles.map((r) => {
          const held = value.filter((a) => a.roleId === r.id);
          return (
            <Checkbox
              key={r.id}
              label={r.name}
              {...(held.some((a) => a.branchId !== null)
                ? { hint: held.map((a) => branchName(a.branchId)).join(', ') }
                : {})}
              checked={held.length > 0}
              onCheckedChange={(on) => onChange(toggleRole(value, r.id, on, branch))}
            />
          );
        })}
      </div>
      <Select
        label={t('staff.branchForNew')}
        wrapperClassName="w-full sm:w-72"
        value={branchValue(branch)}
        onValueChange={(v) => setBranch(branchFromValue(v))}
        options={[
          { value: ALL_BRANCHES, label: t('staff.allBranches') },
          ...branches.map((b) => ({ value: b.id, label: b.name })),
        ]}
      />
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
  const { busy, problems, setProblems, clear, submit } = useSubmit(api);

  const reset = () => {
    setFullName('');
    setUsername('');
    setShortCode('');
    setEmail('');
    setPassword('');
    setAssignments([]);
    setProblems({});
  };
  const save = () => {
    // Every missing must-have at once, at its field (owner answer 6).
    const wrong: Record<string, string> = {};
    if (fullName.trim() === '') wrong['fullName'] = t('staff.problems.fullName');
    if (username.trim() === '') wrong['username'] = t('staff.problems.username');
    setProblems(wrong);
    if (Object.keys(wrong).length > 0) return;
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
    );
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
      actionIcon={UserPlus}
      cancelLabel={t('staff.cancel')}
      busy={busy}
      size="lg"
      errors={problems}
      onSubmit={save}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <TextInput
          label={t('staff.fullName')}
          error={problems['fullName']}
          value={fullName}
          onChange={(e) => {
            setFullName(e.target.value);
            clear('fullName');
          }}
          maxLength={120}
        />
        <TextInput
          label={t('staff.username')}
          error={problems['username']}
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            clear('username');
          }}
          maxLength={64}
          autoComplete="off"
          className="font-mono"
        />
        <TextInput
          label={t('staff.shortCodeField')}
          error={problems['shortCode']}
          value={shortCode}
          onChange={(e) => {
            setShortCode(e.target.value);
            clear('shortCode');
          }}
          maxLength={8}
          autoComplete="off"
          className="font-mono"
        />
        <TextInput
          label={t('staff.email')}
          error={problems['email']}
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            clear('email');
          }}
          maxLength={254}
        />
        <TextInput
          label={t('staff.password.optional')}
          hint={t('staff.password.optionalHelp')}
          error={problems['password']}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            clear('password');
          }}
          wrapperClassName="sm:col-span-2"
        />
      </div>
      <RolePicker roles={roles} branches={branches} value={assignments} onChange={setAssignments} />
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
  const { busy, problems, setProblems, clear, submit } = useSubmit(api);
  return (
    <FormDialog
      open={person !== null}
      onOpenChange={(o) => {
        if (!o) {
          setPin('');
          setProblems({});
        }
        onOpenChange(o);
      }}
      title={t('staff.give')}
      {...(person ? { description: person.fullName } : {})}
      actionLabel={t('staff.save')}
      actionIcon={KeyRound}
      cancelLabel={t('staff.cancel')}
      busy={busy}
      size="sm"
      errors={problems}
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
      <TextInput
        label={t('staff.temporaryPin')}
        error={problems['pin']}
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChange={(e) => {
          setPin(e.target.value);
          clear('pin');
        }}
        maxLength={6}
        className="font-mono tracking-[.3em]"
      />
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
  const { busy, problems, setProblems, clear, submit } = useSubmit(api);
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setPassword('');
          setProblems({});
        }
        onOpenChange(o);
      }}
      title={person.hasPassword ? t('staff.password.reset') : t('staff.password.give')}
      description={t('staff.password.temporaryHelp')}
      actionLabel={t('staff.password.save')}
      actionIcon={Save}
      cancelLabel={t('staff.cancel')}
      busy={busy}
      size="sm"
      errors={problems}
      onSubmit={() =>
        void submit(['PUT', `/api/users/${person.id}/password`, { temporaryPassword: password }], 204, () => {
          setPassword('');
          onSaved();
        })
      }
    >
      <TextInput
        label={t('staff.password.temporary')}
        error={problems['password']}
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          clear('password');
        }}
      />
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
  tone = 'default',
}: {
  api: Api;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  text: ReactNode;
  actionLabel: string;
  call: Parameters<Api>;
  onDone: () => void;
  tone?: 'default' | 'danger';
}) {
  const { t } = useTranslation();
  const { busy, submit } = useSubmit(api);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      actionLabel={actionLabel}
      actionIcon={Check}
      cancelLabel={t('staff.cancel')}
      tone={tone}
      busy={busy}
      size="sm"
      onSubmit={() => void submit(call, 204, onDone)}
    >
      <div className="text-sm text-muted-foreground">{text}</div>
    </FormDialog>
  );
}
