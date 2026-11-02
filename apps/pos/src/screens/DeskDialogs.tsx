import {
  money,
  negate,
  parseMoney,
  parseWholeAmount,
  PIN_MAX_FAILURES,
  sub,
  VARIANCE_REASONS,
  type CashMovementKind,
  type Money,
  type VarianceReason,
} from '@erp/domain';
import {
  Alert,
  AlertDescription,
  formatMoney,
  Input,
  LABEL_CLASS,
  moveSelection,
  OptionList,
  plainAmount,
  TextField,
  type MoneyFormat,
} from '@erp/ui';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CounterCustomer } from '../db/customers';
import type { DeskCustomer, DeskLookups } from '../db/desk';
import { maskPhone, searchCustomers } from '../search/customer-search';
import type { ApproverResult } from '../unlock/approve';
import type { StaffUser } from '../unlock/unlock';
import { Facts, FormDialog } from './BillDialogs';
import { StaffPicker } from './StaffPicker';

// The desk's other dialogs (W1-11, cash desk spec, CSH-05…CSH-07): a customer's collection (Alt+R), a cash-out or
// safe movement (Alt+M), and the drawer close by denomination (Alt+X): a blind count, then the variance with its
// reason, the manager's PIN or Acknowledge later, and what stays in the drawer (owner answers 1–3). The worker checks
// every rule (packages/domain) and answers with the problem's i18n key; a dialog stays open on a refusal.

/** What a dialog's action answers: null when written, else the i18n key of what is wrong. */
type Outcome = Promise<string | null>;

const RADIO = 'flex cursor-pointer items-center gap-2';

export interface CollectionInputUi {
  partyId: string;
  methodId: string;
  amount: Money;
  reference: string | null;
  note: string | null;
}

export function CollectionDialog({
  customers,
  lookups,
  money: fmt,
  load,
  onReceive,
  onClose,
}: {
  customers: readonly CounterCustomer[];
  lookups: DeskLookups;
  money: MoneyFormat;
  load: (partyId: string) => Promise<DeskCustomer | null>;
  onReceive: (input: CollectionInputUi) => Outcome;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, fmt);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [selected, setSelected] = useState(0);
  const [customer, setCustomer] = useState<DeskCustomer | null>(null);
  const [amount, setAmount] = useState('');
  const [methodId, setMethodId] = useState(lookups.methods[0]?.id ?? '');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const found = searchCustomers(customers, text);
  const at = Math.min(selected, found.length - 1);
  const method = lookups.methods.find((x) => x.id === methodId) ?? null;
  const pick = async (i = at) => {
    const c = found[i];
    if (!c) return;
    setCustomer(await load(c.id));
  };

  const parsed = (() => {
    try {
      return parseMoney(amount, fmt.minorUnits);
    } catch {
      return null;
    }
  })();

  const submit = async () => {
    if (customer === null) return void pick();
    if (parsed === null) return setError(t('collection.amount_not_positive'));
    setBusy(true);
    const problem = await onReceive({
      partyId: customer.partyId,
      methodId,
      amount: parsed,
      reference: reference.trim() === '' ? null : reference,
      note: note.trim() === '' ? null : note,
    });
    setBusy(false);
    if (problem) setError(t(problem));
  };

  return (
    <FormDialog
      title={t('desk.collect.title')}
      description={customer === null ? t('desk.collect.help') : undefined}
      actionLabel={customer === null ? t('desk.collect.pick') : t('desk.collect.action')}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {customer === null ? (
        <>
          <Input
            ref={input}
            aria-label={t('customer.search')}
            placeholder={t('customer.search')}
            role="combobox"
            aria-expanded={found.length > 0}
            aria-controls="collect-results"
            autoComplete="off"
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSelected(0);
            }}
            onKeyDown={(e) => {
              const next = moveSelection(at, e.key, found.length);
              if (next === null) return;
              e.preventDefault();
              setSelected(next);
            }}
          />
          <OptionList
            id="collect-results"
            label={t('desk.collect.title')}
            items={found}
            selected={at}
            itemKey={(c) => c.id}
            onSelect={(i) => {
              setSelected(i);
              input.current?.focus();
            }}
            onChoose={(i) => void pick(i)}
            className="max-h-[40vh]"
          >
            {(c) => (
              <div className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-1.5">
                <span className="font-mono text-[12.5px] font-semibold">{c.code}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium wrap-anywhere">{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[c.city, c.phones[0] && maskPhone(c.phones[0])].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="text-xs tabular-nums">
                  {t('customer.balance', { amount: m(c.balance) })}
                </span>
              </div>
            )}
          </OptionList>
          {text.trim() !== '' && found.length === 0 && (
            <p className="m-0 text-muted-foreground">{t('customer.none', { text: text.trim() })}</p>
          )}
        </>
      ) : (
        <>
          <Facts
            facts={[
              [t('desk.collect.customer'), `${customer.name} (${customer.code})`],
              [t('desk.collect.balance'), m(customer.balance)],
              ...(customer.lastCollection
                ? [
                    [
                      t('desk.collect.last'),
                      `${m(customer.lastCollection.amount)} · ${customer.lastCollection.number}`,
                    ] as const,
                  ]
                : []),
              ...(parsed !== null && parsed > 0
                ? [[t('desk.collect.after'), m(sub(customer.balance, parsed))] as const]
                : []),
            ]}
          />
          <TextField
            label={t('desk.collect.amount')}
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            className="font-mono text-lg"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
          />
          <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-1 border-0 p-0">
            <legend className={`${LABEL_CLASS} mb-1`}>{t('desk.collect.method')}</legend>
            {lookups.methods.map((x) => (
              <label key={x.id} className={RADIO}>
                <input
                  type="radio"
                  name="method"
                  checked={methodId === x.id}
                  onChange={() => {
                    setMethodId(x.id);
                    setError(null);
                  }}
                />
                {x.name}
              </label>
            ))}
          </fieldset>
          {method?.requiresReference && (
            <TextField
              label={t('desk.collect.reference')}
              autoComplete="off"
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
                setError(null);
              }}
            />
          )}
          <TextField
            label={t('desk.note')}
            autoComplete="off"
            value={note}
            onChange={(e) => setNote(e.target.value)}
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

export interface CashOutInputUi {
  kind: CashMovementKind;
  amount: Money;
  expenseCategoryId: string | null;
  supplierId: string | null;
  bankAccountId: string | null;
  note: string | null;
  reference: string | null;
  overDrawerConfirmed: boolean;
}

const KINDS: readonly CashMovementKind[] = [
  'expense',
  'supplier_payment',
  'bank_deposit',
  'to_safe',
  'from_safe',
];

export function CashOutDialog({
  lookups,
  expected,
  money: fmt,
  onRecord,
  onClose,
}: {
  lookups: DeskLookups;
  /** What the drawer should hold now. */
  expected: Money;
  money: MoneyFormat;
  /** The problem's key, or `over_drawer` for the second Enter. */
  onRecord: (input: CashOutInputUi) => Outcome;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, fmt);
  const [kind, setKind] = useState<CashMovementKind>('expense');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [confirmOver, setConfirmOver] = useState(false);
  const targetId = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const options: { id: string; label: string }[] =
    kind === 'expense'
      ? lookups.categories.map((c) => ({ id: c.id, label: c.name }))
      : kind === 'supplier_payment'
        ? lookups.suppliers.map((s) => ({
            id: s.partyId,
            label: `${s.name} (${s.code}) · ${t('desk.cashOut.owed', { amount: m(s.balance) })}`,
          }))
        : kind === 'bank_deposit'
          ? lookups.banks.map((b) => ({ id: b.id, label: b.name }))
          : [];
  const reset = () => {
    setError(null);
    setConfirmOver(false);
  };

  const submit = async () => {
    let parsed: Money;
    try {
      parsed = parseWholeAmount(amount, fmt.minorUnits);
    } catch {
      return setError(t('cashOut.amount_not_rounded'));
    }
    const chosen = target === '' ? null : target;
    setBusy(true);
    const problem = await onRecord({
      kind,
      amount: parsed,
      expenseCategoryId: kind === 'expense' ? chosen : null,
      supplierId: kind === 'supplier_payment' ? chosen : null,
      bankAccountId: kind === 'bank_deposit' ? chosen : null,
      note: note.trim() === '' ? null : note,
      reference: reference.trim() === '' ? null : reference,
      overDrawerConfirmed: confirmOver,
    });
    setBusy(false);
    if (problem === 'cashOut.over_drawer') {
      setConfirmOver(true);
      return setError(t('cashOut.over_drawer', { amount: m(expected) }));
    }
    if (problem) setError(t(problem));
  };

  return (
    <FormDialog
      title={t('desk.cashOut.title')}
      description={t('desk.cashOut.help', { amount: m(expected) })}
      actionLabel={confirmOver ? t('desk.cashOut.actionAnyway') : t('desk.cashOut.action')}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <fieldset className="m-0 flex flex-wrap gap-x-4 gap-y-1 border-0 p-0">
        <legend className={`${LABEL_CLASS} mb-1`}>{t('desk.cashOut.kindLabel')}</legend>
        {KINDS.map((k) => (
          <label key={k} className={RADIO}>
            <input
              type="radio"
              name="kind"
              checked={kind === k}
              onChange={() => {
                setKind(k);
                setTarget('');
                reset();
              }}
            />
            {t(`desk.cashOut.kind.${k}`)}
          </label>
        ))}
      </fieldset>
      {kind === 'expense' || kind === 'supplier_payment' || kind === 'bank_deposit' ? (
        // A label beside the select, not around it: Chrome would name the select after its options too.
        <div className="flex flex-col gap-1">
          <label htmlFor={targetId} className={LABEL_CLASS}>
            {t(`desk.cashOut.target.${kind}`)}
          </label>
          <select
            id={targetId}
            className="h-9 rounded-md border border-input bg-surface px-2"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              reset();
            }}
          >
            <option value="">{t('desk.cashOut.choose')}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <TextField
        label={t('desk.cashOut.amount')}
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        className="font-mono text-lg"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          reset();
        }}
      />
      <TextField
        label={kind === 'to_safe' || kind === 'from_safe' ? t('desk.note') : t('desk.cashOut.note')}
        autoComplete="off"
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          reset();
        }}
      />
      <TextField
        label={t('desk.cashOut.reference')}
        autoComplete="off"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      {error && (
        <Alert variant={confirmOver ? 'default' : 'destructive'}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormDialog>
  );
}

export interface CloseInputUi {
  counts: Record<string, number>;
  reason: VarianceReason | null;
  note: string | null;
  acknowledgerId: string | null;
  leftInDrawer: Money | null;
}

/** The manager's PIN for a variance: `checkVarianceApprover` with the person picked. */
export type AcknowledgeAttempt = (
  approver: StaffUser,
  pin: string,
) => Promise<{ result: ApproverResult; failures: number }>;

export function CountDialog({
  denominations,
  expected,
  money: fmt,
  staff,
  onAcknowledge,
  onCloseSession,
  onClose,
}: {
  denominations: readonly Money[];
  /** What the drawer should hold: shown only after the count (owner answer 2). */
  expected: Money;
  money: MoneyFormat;
  staff: StaffUser[];
  onAcknowledge: AcknowledgeAttempt;
  onCloseSession: (input: CloseInputUi) => Outcome;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, fmt);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [counted, setCounted] = useState<Money | null>(null);
  const [reason, setReason] = useState<VarianceReason | null>(null);
  const [note, setNote] = useState('');
  const [approver, setApprover] = useState<StaffUser | null>(null);
  const [pin, setPin] = useState('');
  const [acknowledged, setAcknowledged] = useState<string | null>(null);
  const [later, setLater] = useState(false);
  const [left, setLeft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const numbers = (): Record<string, number> | null => {
    const out: Record<string, number> = {};
    for (const [d, v] of Object.entries(counts)) {
      if (v.trim() === '') continue;
      if (!/^\d+$/.test(v.trim())) return null;
      out[d] = Number(v.trim());
    }
    return out;
  };
  const running = (() => {
    const n = numbers();
    return n === null ? null : Object.entries(n).reduce((s, [d, c]) => s + Number(d) * c, 0);
  })();
  const variance = counted === null ? null : sub(counted, expected);

  const finishCount = () => {
    if (running === null) return setError(t('close.invalid_count'));
    setCounted(money(running));
    setLeft(plainAmount(running, fmt.minorUnits));
    setError(null);
  };

  const checkPin = async () => {
    if (approver === null || pin === '') return;
    setBusy(true);
    const r = await onAcknowledge(approver, pin);
    setBusy(false);
    setPin('');
    if (r.result === 'approved') {
      setAcknowledged(approver.id);
      return setError(null);
    }
    setError(
      r.result === 'wrong'
        ? t('approval.wrong', { count: PIN_MAX_FAILURES - r.failures })
        : r.result === 'approver_locked'
          ? t('approval.locked')
          : t('desk.count.notAcknowledger'),
    );
  };

  const submit = async () => {
    if (counted === null) return finishCount();
    if (variance !== 0) {
      if (reason === null) return setError(t('close.reason_required'));
      if (acknowledged === null && !later) {
        if (approver !== null && pin !== '') return void checkPin();
        return setError(t('desk.count.ackNeeded'));
      }
    }
    let stays: Money;
    try {
      stays = parseWholeAmount(left, fmt.minorUnits);
    } catch {
      return setError(t('close.left_invalid'));
    }
    setBusy(true);
    const problem = await onCloseSession({
      counts: numbers() ?? {},
      reason: variance === 0 ? null : reason,
      note: note.trim() === '' ? null : note,
      acknowledgerId: variance === 0 ? null : acknowledged,
      leftInDrawer: stays,
    });
    setBusy(false);
    if (problem) setError(t(problem));
  };

  return (
    <FormDialog
      title={t('desk.count.title')}
      description={counted === null ? t('desk.count.help') : undefined}
      actionLabel={counted === null ? t('desk.count.done') : t('desk.count.action')}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {counted === null ? (
        <>
          <div className="grid grid-cols-[auto_6rem_auto] items-center gap-x-3 gap-y-1">
            {denominations.map((d, i) => (
              <div key={d} className="contents">
                <label htmlFor={`count-${d}`} className="text-end font-semibold tabular-nums">
                  {m(d)} ×
                </label>
                <Input
                  id={`count-${d}`}
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus={i === 0}
                  className="font-mono"
                  value={counts[String(d)] ?? ''}
                  onChange={(e) => {
                    setCounts((c) => ({ ...c, [String(d)]: e.target.value }));
                    setError(null);
                  }}
                />
                <span className="text-end tabular-nums text-muted-foreground">
                  {/^\d+$/.test((counts[String(d)] ?? '').trim()) ? m(d * Number(counts[String(d)])) : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="m-0 text-end text-lg font-bold tabular-nums">
            {t('desk.count.counted', { amount: running === null ? '—' : m(running) })}
          </p>
        </>
      ) : (
        <>
          <Facts
            facts={[
              [t('desk.count.countedLabel'), m(counted)],
              [t('desk.expected'), m(expected)],
            ]}
          />
          <p
            role="status"
            className={`m-0 text-2xl font-bold ${variance === 0 ? 'text-ok' : variance! < 0 ? 'text-bad' : 'text-warn'}`}
          >
            {variance === 0
              ? t('desk.count.exact')
              : variance! < 0
                ? t('desk.count.short', { amount: m(negate(variance!)) })
                : t('desk.count.over', { amount: m(variance!) })}
          </p>
          {variance !== 0 && (
            <>
              <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
                <legend className={`${LABEL_CLASS} mb-1`}>{t('desk.count.reasonLabel')}</legend>
                {VARIANCE_REASONS.map((r) => (
                  <label key={r} className={RADIO}>
                    <input
                      type="radio"
                      name="reason"
                      checked={reason === r}
                      onChange={() => {
                        setReason(r);
                        setError(null);
                      }}
                    />
                    {t(`desk.count.reason.${r}`)}
                  </label>
                ))}
              </fieldset>
              <TextField
                label={t('desk.note')}
                autoComplete="off"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {acknowledged !== null ? (
                <p className="m-0 font-semibold text-ok">
                  {t('desk.count.acknowledgedBy', {
                    name: staff.find((s) => s.id === acknowledged)?.fullName ?? '',
                  })}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <span className={LABEL_CLASS}>{t('desk.count.ackLabel')}</span>
                  {!later &&
                    (approver === null ? (
                      <StaffPicker
                        staff={staff}
                        onPick={setApprover}
                        shortCodeLabel={t('unlock.shortCode')}
                      />
                    ) : (
                      <TextField
                        label={t('desk.count.pin', { name: approver.fullName })}
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        autoFocus
                        className="text-center font-mono text-xl tracking-[.4em]"
                        value={pin}
                        onChange={(e) => setPin(e.target.value)}
                      />
                    ))}
                  <label className={RADIO}>
                    <input
                      type="checkbox"
                      checked={later}
                      onChange={(e) => {
                        setLater(e.target.checked);
                        setError(null);
                      }}
                    />
                    {t('desk.count.later')}
                  </label>
                </div>
              )}
            </>
          )}
          <TextField
            label={t('desk.count.left')}
            inputMode="numeric"
            autoComplete="off"
            className="font-mono"
            value={left}
            onChange={(e) => {
              setLeft(e.target.value);
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
