import { OVERRIDE_REASONS, PIN_MAX_FAILURES, type OverrideReason, type PendingApproval } from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  LABEL_CLASS,
  TextField,
} from '@erp/ui';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Tier } from '../search/search-index';
import type { ApproverResult } from '../unlock/approve';
import type { StaffUser } from '../unlock/unlock';
import { StaffPicker } from './StaffPicker';

// The counter's bill dialogs (POS spec §10–§11). Each ends with the D-053 bar: Cancel (Esc) and a main button named
// after its action, which does exactly what Enter does.

/** A dialog around a form: title, optional text, the fields, the D-053 bar. Gives focus back where it came from. */
export function FormDialog({
  title,
  description,
  actionLabel,
  busy = false,
  onSubmit,
  onClose,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actionLabel: string;
  busy?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const opener = useRef<HTMLElement | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
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
          <DialogActions cancelLabel={t('dialog.cancel')} actionLabel={actionLabel} busy={busy} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Label/value pairs above a field: the item, list price, floor… */
export function Facts({ facts }: { facts: readonly (readonly [string, ReactNode])[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1 text-[13.5px]">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="m-0 font-semibold tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One typed value (quantity, price, discount): `onSubmit` returns the i18n key of what is wrong, or null. */
export function EntryDialog({
  title,
  description,
  label,
  facts = [],
  initial,
  actionLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string | undefined;
  label: string;
  facts?: readonly (readonly [string, ReactNode])[];
  initial: string;
  actionLabel: string;
  onSubmit: (text: string) => string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      title={title}
      description={description}
      actionLabel={actionLabel}
      onClose={onClose}
      onSubmit={() => {
        const problem = onSubmit(text);
        if (problem) setError(t(problem));
      }}
    >
      <Facts facts={facts} />
      <TextField
        label={label}
        inputMode="decimal"
        autoComplete="off"
        autoFocus
        onFocus={(e) => e.target.select()}
        className="font-mono"
        value={text}
        error={error}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
      />
    </FormDialog>
  );
}

/** The price tiers as a radio group: arrows move, Enter uses the chosen tier (`F7`). */
export function TierDialog({
  tiers,
  current,
  onChoose,
  onClose,
}: {
  tiers: readonly Tier[];
  current: string;
  onChoose: (tierId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState(current);
  return (
    <FormDialog
      title={t('tier.title')}
      actionLabel={t('tier.action')}
      onClose={onClose}
      onSubmit={() => onChoose(chosen)}
    >
      {/* Enter on a radio button doesn't submit a form in every browser: it does here (D-053). */}
      <fieldset
        className="m-0 flex flex-col gap-1.5 border-0 p-0"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          onChoose(chosen);
        }}
      >
        <legend className="sr-only">{t('tier.title')}</legend>
        {tiers.map((tier) => (
          <label
            key={tier.id}
            className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 has-checked:border-focus has-checked:bg-select"
          >
            <input
              type="radio"
              name="tier"
              value={tier.id}
              checked={chosen === tier.id}
              autoFocus={chosen === tier.id}
              onChange={() => setChosen(tier.id)}
            />
            <span className="font-semibold">{tier.name}</span>
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}

export function ConfirmDialog({
  title,
  body,
  actionLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <FormDialog
      title={title}
      description={body}
      actionLabel={actionLabel}
      onClose={onClose}
      onSubmit={onConfirm}
    />
  );
}

export type ApprovalAttempt = (
  approver: StaffUser,
  pin: string,
  reason: OverrideReason,
  note: string | null,
) => Promise<{ result: ApproverResult; failures: number }>;

/**
 * An approval on the same screen (POS spec §10, PLT-07): the approver picks their name (or types their short code),
 * enters their own PIN and a reason. The PIN is checked by `onApprove`; a refusal says why and stays open.
 */
export function ApprovalDialog({
  pending,
  facts,
  staff,
  onApprove,
  onClose,
}: {
  pending: PendingApproval;
  facts: readonly (readonly [string, ReactNode])[];
  staff: StaffUser[];
  onApprove: ApprovalAttempt;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [approver, setApprover] = useState<StaffUser | null>(null);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState<OverrideReason>('customer_bargain');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!approver || pin === '') return;
    const trimmed = note.trim();
    if (reason === 'other' && trimmed === '') return setError(t('approval.noteRequired'));
    setBusy(true);
    const r = await onApprove(approver, pin, reason, trimmed === '' ? null : trimmed);
    setBusy(false);
    setPin('');
    if (r.result === 'approved') return;
    setError(
      r.result === 'wrong'
        ? t('approval.wrong', { count: PIN_MAX_FAILURES - r.failures })
        : r.result === 'approver_locked'
          ? t('approval.locked')
          : t('approval.notAllowed'),
    );
  };

  return (
    <FormDialog
      title={t('approval.title')}
      description={t(`approval.${pending.need}`)}
      actionLabel={busy ? t('approval.checking') : t('approval.action')}
      busy={busy || approver === null}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Facts facts={facts} />
      {approver === null ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-muted-foreground">{t('approval.who')}</p>
          <StaffPicker staff={staff} onPick={setApprover} shortCodeLabel={t('unlock.shortCode')} />
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <span>
              <span className={LABEL_CLASS}>{t('approval.approver')}</span>{' '}
              <span className="font-semibold">{approver.fullName}</span>
            </span>
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent text-sm text-focus underline"
              onClick={() => {
                setApprover(null);
                setPin('');
                setError(null);
              }}
            >
              {t('approval.back')}
            </button>
          </div>
          <TextField
            label={t('approval.pin')}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            className="text-center font-mono text-xl tracking-[.4em]"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className={`${LABEL_CLASS} mb-1`}>{t('approval.reason')}</legend>
            {OVERRIDE_REASONS.map((r) => (
              <label key={r} className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="reason"
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                />
                {t(`override.reason.${r}`)}
              </label>
            ))}
          </fieldset>
          <TextField
            label={t('approval.note')}
            autoComplete="off"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setError(null);
            }}
          />
        </>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormDialog>
  );
}
