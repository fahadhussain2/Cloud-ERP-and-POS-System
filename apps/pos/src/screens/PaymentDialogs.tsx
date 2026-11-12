import {
  add,
  checkCredit,
  checkTender,
  DomainError,
  money as toMoney,
  negate,
  parseWholeAmount,
  quickCash,
  sub,
  sum,
  type CreditView,
  type Money,
  type Tender,
  type TenderLine,
} from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Button,
  cn,
  formatMoney,
  Input,
  LABEL_CLASS,
  plainAmount,
  TextField,
} from '@erp/ui';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { CheckoutSettings, PaymentMethodRow } from '../db/checkout';
import { FormDialog } from './BillDialogs';

// Paying a bill (POS spec §12, §15, POS-06, POS-07, POS-17, D-053): the Cash, method, On account and Split popups. Each ends with Cancel (Esc)
// and Finalize & print (Enter); Esc leaves the bill as it was. The rules are checkTender's; `onPay` finalizes and
// answers with the i18n key of what went wrong, or null.

export type Pay = (tender: Tender) => Promise<string | null>;

interface PayProps {
  settings: CheckoutSettings;
  total: Money;
  money: { locale: string; currency: string; minorUnits: number };
  /** The bill's customer may buy on account and the seller may sell on account (POS spec §15). */
  creditCustomer?: boolean;
  onPay: Pay;
  onClose: () => void;
}

/** A typed whole amount: empty, a value, or the i18n key of what is wrong with it. */
type Typed = { kind: 'empty' } | { kind: 'ok'; value: Money } | { kind: 'bad'; key: string };

function useAmounts(minorUnits: number) {
  const { i18n } = useTranslation();
  const keyOf = (err: unknown) => {
    if (!(err instanceof DomainError)) throw err;
    return i18n.exists(`error.${err.code}`) ? `error.${err.code}` : 'error.other';
  };
  const read = (text: string): Typed => {
    if (text.trim() === '') return { kind: 'empty' };
    try {
      return { kind: 'ok', value: parseWholeAmount(text, minorUnits) };
    } catch (err) {
      return { kind: 'bad', key: keyOf(err) };
    }
  };
  return { read, keyOf };
}

/** Runs one payment at a time: a second Enter while the first is saving does nothing. */
function usePaying(onPay: Pay) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pay = async (tender: Tender) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const problem = await onPay(tender);
    setBusy(false);
    if (problem) setError(t(problem));
  };
  return { busy, error, setError: (key: string | null) => setError(key && t(key)), pay };
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Alert variant="destructive">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

function Big({ label, children, tone }: { label: string; children: ReactNode; tone?: 'good' | 'refund' }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={LABEL_CLASS}>{label}</span>
      <span
        className={cn(
          'font-display text-[34px] leading-none font-bold tabular-nums',
          tone === 'good' && 'text-ok',
          tone === 'refund' && 'text-warn',
        )}
      >
        {children}
      </span>
    </div>
  );
}

const check = (s: CheckoutSettings, total: Money, tender: Tender, creditCustomer = false) =>
  checkTender({
    total,
    increment: s.increment,
    methods: s.methods,
    tender,
    hasCreditCustomer: creditCustomer,
  });

/** Cash (`F9`): Enter with the field empty is the exact amount; the quick-cash buttons finalize in one click. */
export function CashDialog({ settings, total, money, onPay, onClose }: PayProps) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, money);
  const { read } = useAmounts(money.minorUnits);
  const { busy, error, setError, pay } = usePaying(onPay);
  const [text, setText] = useState('');
  const cash = settings.methods.find((x) => x.isCash)?.code ?? 'cash';
  const tender = (cashReceived: Money | null): Tender => ({
    payments: [{ method: cash, amount: total, reference: null }],
    cashReceived,
  });
  const typed = read(text);
  const change = typed.kind === 'ok' && typed.value >= total ? sub(typed.value, total) : null;

  const submit = () => {
    if (typed.kind === 'empty') return void pay(tender(null));
    if (typed.kind === 'bad') return setError(typed.key);
    if (typed.value < total) return setError('pay.lessThanTotal');
    void pay(tender(typed.value));
  };

  return (
    <FormDialog
      title={t('pay.cashTitle')}
      actionLabel={busy ? t('pay.saving') : t('pay.finalize')}
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
    >
      <Big label={t('pay.total')} tone="good">
        <span data-testid="pay-total">{m(total)}</span>
      </Big>
      <TextField
        label={t('pay.cashReceived')}
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        className="h-12 font-mono text-xl"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('pay.quickCash')}>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void pay(tender(null))}>
          {t('pay.exact')}
        </Button>
        {quickCash(total, toMoney(10 ** money.minorUnits)).map((a) => (
          <Button
            key={a}
            type="button"
            variant="outline"
            disabled={busy}
            className="flex h-auto flex-col items-start py-1.5"
            onClick={() => void pay(tender(a))}
          >
            <span className="font-semibold tabular-nums">{m(a)}</span>
            <span className="text-xs text-muted-foreground">
              {t('pay.changeAmount', { amount: m(sub(a, total)) })}
            </span>
          </Button>
        ))}
      </div>
      <Big label={t('pay.change')}>
        <span data-testid="pay-change">{m(change ?? 0)}</span>
      </Big>
      <Problem text={error} />
    </FormDialog>
  );
}

/** The reference field's label for a method (POS spec §12), "(optional)" when the method doesn't require one. */
function useReferenceLabel() {
  const { t, i18n } = useTranslation();
  return (method: PaymentMethodRow) => {
    const key = `pay.reference.${method.code}`;
    const label = t(i18n.exists(key) ? key : 'pay.reference.other');
    return method.requiresReference ? label : t('pay.optional', { label });
  };
}

/** A non-cash method (Bank transfer, Raast, JazzCash…): the whole total, and its reference. */
export function MethodDialog({
  method,
  settings,
  total,
  money,
  onPay,
  onClose,
}: PayProps & { method: PaymentMethodRow }) {
  const { t } = useTranslation();
  const referenceLabel = useReferenceLabel();
  const { busy, error, setError, pay } = usePaying(onPay);
  const [reference, setReference] = useState('');

  const submit = () => {
    const tender: Tender = {
      payments: [
        { method: method.code, amount: total, reference: reference.trim() === '' ? null : reference },
      ],
      cashReceived: null,
    };
    const problem = check(settings, total, tender);
    if (problem) return setError(`tender.${problem}`);
    void pay(tender);
  };

  return (
    <FormDialog
      title={method.name}
      actionLabel={busy ? t('pay.saving') : t('pay.finalize')}
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
    >
      <Big label={t('pay.amount')} tone="good">
        <span data-testid="pay-total">{formatMoney(total, money)}</span>
      </Big>
      <TextField
        label={referenceLabel(method)}
        autoComplete="off"
        autoFocus
        className="font-mono"
        value={reference}
        onChange={(e) => {
          setReference(e.target.value);
          setError(null);
        }}
      />
      <Problem text={error} />
    </FormDialog>
  );
}

/** Split payment (`Shift+F9`): one row per method, cash first and prefilled with the total; cash received on its row. */
export function SplitDialog({ settings, total, money, creditCustomer = false, onPay, onClose }: PayProps) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, money);
  const referenceLabel = useReferenceLabel();
  const { read } = useAmounts(money.minorUnits);
  const { busy, error, setError, pay } = usePaying(onPay);
  // On account only for a credit customer (POS spec §15); its part is checked against the limit when finalizing.
  const rows = settings.methods
    .filter((x) => x.code !== 'on_account' || creditCustomer)
    .sort((a, b) => Number(b.isCash) - Number(a.isCash));
  const first = rows[0]?.code;
  const [amounts, setAmounts] = useState<Record<string, string>>(
    first ? { [first]: plainAmount(total, money.minorUnits) } : {},
  );
  const [references, setReferences] = useState<Record<string, string>>({});
  const [receivedText, setReceivedText] = useState('');

  const typed = rows.map((r) => ({ row: r, amount: read(amounts[r.code] ?? '') }));
  const covered = sum(typed.flatMap((x) => (x.amount.kind === 'ok' ? [x.amount.value] : [])));
  const left = sub(total, covered);
  const cashRow = typed.find((x) => x.row.isCash);
  const received = read(receivedText);
  const change =
    cashRow?.amount.kind === 'ok' && received.kind === 'ok' && received.value >= cashRow.amount.value
      ? sub(received.value, cashRow.amount.value)
      : toMoney(0);

  const submit = () => {
    const bad =
      typed.find((x) => x.amount.kind === 'bad')?.amount ?? (received.kind === 'bad' ? received : null);
    if (bad?.kind === 'bad') return setError(bad.key);
    const payments: TenderLine[] = typed.flatMap(({ row, amount }) =>
      amount.kind === 'ok' && amount.value !== 0
        ? [{ method: row.code, amount: amount.value, reference: references[row.code]?.trim() || null }]
        : [],
    );
    const tender: Tender = { payments, cashReceived: received.kind === 'ok' ? received.value : null };
    const problem = check(settings, total, tender, creditCustomer);
    if (problem) return setError(`tender.${problem}`);
    void pay(tender);
  };

  const edit =
    (setter: (v: Record<string, string>) => void, all: Record<string, string>, code: string) =>
    (value: string) => {
      setter({ ...all, [code]: value });
      setError(null);
    };

  return (
    <FormDialog
      title={t('pay.splitTitle')}
      actionLabel={busy ? t('pay.saving') : t('pay.finalize')}
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
    >
      <Big label={t('pay.total')} tone="good">
        <span data-testid="pay-total">{m(total)}</span>
      </Big>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div
            key={row.code}
            className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-2"
          >
            <span className="font-semibold">{row.name}</span>
            <Input
              aria-label={t('pay.amountOf', { method: row.name })}
              inputMode="numeric"
              autoComplete="off"
              autoFocus={i === 0}
              className="font-mono tabular-nums"
              value={amounts[row.code] ?? ''}
              onChange={(e) => edit(setAmounts, amounts, row.code)(e.target.value)}
            />
            {row.isCash ? (
              <Input
                aria-label={t('pay.cashReceived')}
                placeholder={t('pay.cashReceived')}
                inputMode="numeric"
                autoComplete="off"
                className="font-mono tabular-nums"
                value={receivedText}
                onChange={(e) => {
                  setReceivedText(e.target.value);
                  setError(null);
                }}
              />
            ) : row.code === 'on_account' ? (
              <span />
            ) : (
              <Input
                aria-label={t('pay.referenceOf', { method: row.name, label: referenceLabel(row) })}
                placeholder={referenceLabel(row)}
                autoComplete="off"
                className="font-mono"
                value={references[row.code] ?? ''}
                onChange={(e) => edit(setReferences, references, row.code)(e.target.value)}
              />
            )}
          </div>
        ))}
      </div>
      <p className="m-0 font-semibold" role="status" data-testid="split-left">
        {left > 0
          ? t('pay.toCover', { amount: m(left) })
          : left < 0
            ? t('pay.tooMuch', { amount: m(negate(left)) })
            : t('pay.covered')}
      </p>
      {cashRow && (
        <Big label={t('pay.change')}>
          <span data-testid="pay-change">{m(change)}</span>
        </Big>
      )}
      <Problem text={error} />
    </FormDialog>
  );
}

/**
 * On account (POS spec §15, PRD W2): the whole bill on the customer's account. Shows the balance and when it was
 * pulled, this counter's bills the server hasn't counted yet, the balance after this bill, the limit and, offline,
 * today's cap. Over either, Finalize asks for an approval (the screen opens it); no cash moves.
 */
export function OnAccountDialog({
  total,
  money,
  customerName,
  figures,
  timeZone,
  onPay,
  onClose,
}: {
  total: Money;
  money: { locale: string; currency: string; minorUnits: number };
  customerName: string;
  figures: CreditView;
  timeZone: string;
  onPay: Pay;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, money);
  const { busy, error, pay } = usePaying(onPay);
  const c = checkCredit({ ...figures, amount: total });
  const asOf =
    figures.balanceAsOf === null
      ? t('credit.notPulled')
      : new Intl.DateTimeFormat(money.locale, { timeStyle: 'short', timeZone }).format(
          new Date(figures.balanceAsOf),
        );
  const facts: [string, ReactNode][] = [
    [t('credit.balance', { time: asOf }), m(figures.balance)],
    [t('credit.unsynced'), m(figures.unsynced)],
    [t('credit.after'), m(add(add(figures.balance, figures.unsynced), total))],
    [
      t('credit.limit'),
      figures.account?.creditLimit === null || figures.account === null
        ? t('credit.noLimit')
        : m(figures.account.creditLimit),
    ],
  ];
  if (figures.offline && figures.account)
    facts.push([
      t('credit.capToday'),
      t('credit.capUsed', { used: m(figures.offlineToday), cap: m(figures.account.offlineDailyCap) }),
    ]);
  const warnings = c.allowed
    ? [
        c.overLimitBy > 0 ? t('credit.overLimit', { amount: m(c.overLimitBy) }) : null,
        c.overCapBy > 0 ? t('credit.overCap', { amount: m(c.overCapBy) }) : null,
      ].filter((x): x is string => x !== null)
    : [t('tender.on_account_needs_customer')];

  return (
    <FormDialog
      title={t('credit.title', { name: customerName })}
      actionLabel={busy ? t('pay.saving') : t('pay.finalize')}
      busy={busy || !c.allowed}
      onClose={onClose}
      onSubmit={() =>
        void pay({ payments: [{ method: 'on_account', amount: total, reference: null }], cashReceived: null })
      }
    >
      <Big label={t('pay.total')} tone="good">
        <span data-testid="pay-total">{m(total)}</span>
      </Big>
      <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1" data-testid="credit-facts">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 text-end font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {warnings.map((w) => (
        <Alert key={w} variant="destructive">
          <AlertDescription>{w}</AlertDescription>
        </Alert>
      ))}
      <Problem text={error} />
    </FormDialog>
  );
}

/**
 * A refund (POS spec §19, PRD W7, D-007, D-053): the whole net back in orange, to the cash desk (a payout in its
 * queue), to the customer's account, or by transfer to a bank or wallet method with its reference (owner answer 1 to
 * W1-13: a manager approves it next). `total` is below 0.
 */
export function RefundDialog({
  to,
  settings,
  total,
  money,
  customerName,
  onPay,
  onClose,
}: Omit<PayProps, 'creditCustomer'> & { to: 'cash' | 'account' | 'transfer'; customerName: string | null }) {
  const { t } = useTranslation();
  const referenceLabel = useReferenceLabel();
  const { busy, error, setError, pay } = usePaying(onPay);
  const transfers = settings.methods.filter((x) => !x.isCash && x.code !== 'on_account');
  const [method, setMethod] = useState(transfers[0]?.code ?? '');
  const [reference, setReference] = useState('');
  const chosen = transfers.find((x) => x.code === method);
  const code = to === 'cash' ? 'cash' : to === 'account' ? 'on_account' : method;

  const submit = () => {
    const tender: Tender = {
      payments: [{ method: code, amount: total, reference: reference.trim() === '' ? null : reference }],
      cashReceived: null,
    };
    const problem = checkTender({
      total,
      increment: settings.increment,
      methods: settings.methods,
      tender,
      hasCreditCustomer: false,
      hasReturns: true,
      hasCustomerAccount: customerName !== null,
    });
    if (problem) return setError(`tender.${problem}`);
    void pay(tender);
  };

  return (
    <FormDialog
      title={t(`refund.title.${to}`)}
      description={
        to === 'account' && customerName ? t('refund.toAccount', { name: customerName }) : undefined
      }
      actionLabel={busy ? t('pay.saving') : t('pay.finalize')}
      busy={busy}
      onClose={onClose}
      onSubmit={submit}
    >
      <Big label={t('refund.amount')} tone="refund">
        <span data-testid="refund-total">{formatMoney(negate(total), money)}</span>
      </Big>
      {to === 'cash' && <p className="m-0 text-muted-foreground">{t('refund.atDesk')}</p>}
      {to === 'transfer' && (
        <>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('refund.method')}>
            {transfers.map((x) => (
              <Button
                key={x.code}
                type="button"
                role="radio"
                aria-checked={x.code === method}
                variant={x.code === method ? 'default' : 'outline'}
                onClick={() => {
                  setMethod(x.code);
                  setError(null);
                }}
              >
                {x.name}
              </Button>
            ))}
          </div>
          {chosen && (
            <TextField
              label={referenceLabel(chosen)}
              autoComplete="off"
              autoFocus
              className="font-mono"
              value={reference}
              onChange={(e) => {
                setReference(e.target.value);
                setError(null);
              }}
            />
          )}
          <p className="m-0 text-muted-foreground">{t('refund.transferApproval')}</p>
        </>
      )}
      <Problem text={error} />
    </FormDialog>
  );
}
