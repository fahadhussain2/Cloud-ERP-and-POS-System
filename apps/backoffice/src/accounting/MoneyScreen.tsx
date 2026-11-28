import type {
  AccountingDocumentRow,
  AccountingDocumentType,
  AccountingDocumentView,
  AccountingLookups,
  PartyHit,
} from '@erp/contracts';
import {
  formatMoney,
  PageHeader,
  Panel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@erp/ui';
import type { TFunction } from 'i18next';
import { Plus, Save, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyValue } from '../catalog/data';
import { href, navigate } from '../router';
import { Button, FIELD_LABEL, FormDialog, notify, Select, TextInput } from '../ui';
import {
  accountingRefusal,
  LineEffectHint,
  PartyPicker,
  placeName,
  problemText,
  useAccountingLookups,
} from './data';

// Money in and out of the banks and the safe (W1-19; ACC-04, ACC-05; D-108): every receipt, expense, transfer,
// supplier payment and journal voucher in one list; a new receipt, expense or transfer in a dialog, posted when saved;
// a document's journal and its reversal. W2-15 (D-127): the back office's own controls; problems at their field,
// results and other refusals as toasts (owner answer 6).

const TYPES: AccountingDocumentType[] = [
  'customer_receipt',
  'expense',
  'fund_transfer',
  'supplier_payment',
  'journal_voucher',
];

type NewKind = 'receipt' | 'expense' | 'transfer';

/** Where a row opens: a voucher draft in its editor, anything else in the document view. */
const rowHref = (d: AccountingDocumentRow) =>
  d.type === 'journal_voucher' && d.status === 'draft'
    ? href.voucher(d.id)
    : href.accountingDocument(d.type, d.id);

export function MoneyScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const lookups = useAccountingLookups(api, version);
  const [type, setType] = useState<AccountingDocumentType | null>(null);
  const [rows, setRows] = useState<AccountingDocumentRow[] | null>(null);
  const [dialog, setDialog] = useState<NewKind | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/accounting/documents${type ? `?type=${type}` : ''}`).then(
      (r) => live && setRows(r.status === 200 ? (r.body as AccountingDocumentRow[]) : []),
    );
    return () => {
      live = false;
    };
  }, [api, type, version]);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const m = lookups.money;
  const finished = (number: string) => {
    setDialog(null);
    notify.done(t('accounting.money.saved', { number }));
    setVersion((v) => v + 1);
  };
  return (
    <>
      <PageHeader
        title={t('accounting.money.title')}
        help={t('accounting.money.help', { lockDate: lookups.lockDate ?? t('accounting.periods.none') })}
        actions={
          <div className="flex flex-wrap gap-2">
            {lookups.can.receipt && (
              <Button icon={Plus} onClick={() => setDialog('receipt')}>
                {t('accounting.money.newReceipt')}
              </Button>
            )}
            {lookups.can.expense && (
              <Button variant="outline" icon={Plus} onClick={() => setDialog('expense')}>
                {t('accounting.money.newExpense')}
              </Button>
            )}
            {lookups.can.transfer && (
              <Button variant="outline" icon={Plus} onClick={() => setDialog('transfer')}>
                {t('accounting.money.newTransfer')}
              </Button>
            )}
            {lookups.can.journal && (
              <Button variant="outline" icon={Plus} onClick={() => navigate(href.voucher('new'))}>
                {t('accounting.money.newVoucher')}
              </Button>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('accounting.money.show')}>
        <Button size="sm" variant={type === null ? 'default' : 'outline'} onClick={() => setType(null)}>
          {t('accounting.money.all')}
        </Button>
        {TYPES.map((k) => (
          <Button key={k} size="sm" variant={type === k ? 'default' : 'outline'} onClick={() => setType(k)}>
            {t(`accounting.types.${k}`)}
          </Button>
        ))}
      </div>
      <Panel className="overflow-x-auto px-1.5 pb-2.5">
        {rows === null ? (
          <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('accounting.money.empty')}</p>
        ) : (
          <Table aria-label={t('accounting.money.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('accounting.fields.number')}</TableHead>
                <TableHead>{t('accounting.fields.date')}</TableHead>
                <TableHead>{t('accounting.fields.type')}</TableHead>
                <TableHead>{t('accounting.fields.description')}</TableHead>
                <TableHead className="text-end">{t('accounting.fields.amount')}</TableHead>
                <TableHead>{t('accounting.fields.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow key={`${d.type}-${d.id}`}>
                  <TableCell>
                    <a
                      href={rowHref(d)}
                      className="font-mono font-semibold underline-offset-4 hover:underline"
                    >
                      {d.number ?? t('accounting.voucher.draft')}
                    </a>
                  </TableCell>
                  <TableCell>{d.date}</TableCell>
                  <TableCell>{t(`accounting.types.${d.type}`)}</TableCell>
                  <TableCell>
                    {d.reverses
                      ? t('accounting.money.reverses', { number: d.reverses.number })
                      : d.description}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatMoney(d.amount, m)}</TableCell>
                  <TableCell>
                    {d.status === 'draft' ? (
                      <StatusChip tone="warn">{t('accounting.status.draft')}</StatusChip>
                    ) : d.reversedBy ? (
                      <StatusChip tone="neutral">
                        {t('accounting.status.reversed', { number: d.reversedBy.number })}
                      </StatusChip>
                    ) : (
                      <StatusChip tone="ok">{t('accounting.status.posted')}</StatusChip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
      {dialog !== null && (
        <MoneyDialog
          api={api}
          lookups={lookups}
          kind={dialog}
          onOpenChange={(o) => !o && setDialog(null)}
          onDone={finished}
        />
      )}
    </>
  );
}

/** The field each problem the API names is about, in a money dialog (owner answer 6: problems at their field). */
const FIELD_OF: Record<string, MoneyField> = {
  date_locked: 'date',
  date_in_future: 'date',
  amount_invalid: 'amount',
  charges_invalid: 'charges',
  customer_required: 'customer',
};
type MoneyField = 'customer' | 'amount' | 'charges' | 'date';

/**
 * A refusal's problems at their fields, when every one names a field; null when the refusal isn't about fields (a
 * toast then).
 */
function fieldProblems(t: TFunction, body: unknown): Partial<Record<MoneyField, string>> | null {
  const b = body as {
    error?: string;
    problems?: (string | { problem: string })[];
    lockDate?: string;
  } | null;
  const codes =
    b?.error === 'invalid' && b.problems?.length
      ? b.problems.map((p) => (typeof p === 'string' ? p : p.problem))
      : b?.error === 'date_locked' || b?.error === 'date_in_future'
        ? [b.error]
        : [];
  if (codes.length === 0 || !codes.every((c) => FIELD_OF[c])) return null;
  const at: Partial<Record<MoneyField, string>> = {};
  for (const c of codes)
    at[FIELD_OF[c]!] = b?.error === 'invalid' ? problemText(t, c) : accountingRefusal(t, b);
  return at;
}

/** A new receipt, expense or transfer: checked by the server and posted when saved (D-108). */
function MoneyDialog({
  api,
  lookups,
  kind,
  onOpenChange,
  onDone,
}: {
  api: Api;
  lookups: AccountingLookups;
  kind: NewKind;
  onOpenChange: (open: boolean) => void;
  onDone: (number: string) => void;
}) {
  const { t } = useTranslation();
  const banks = lookups.banks;
  const categories = lookups.categories.filter((c) => c.active);
  const [customer, setCustomer] = useState<PartyHit | null>(null);
  const [bank, setBank] = useState(banks[0]?.id ?? '');
  const [category, setCategory] = useState(categories[0]?.id ?? '');
  const [from, setFrom] = useState<string>('safe');
  const [to, setTo] = useState<string>(banks[0]?.id ?? 'safe');
  const [amount, setAmount] = useState('');
  const [charges, setCharges] = useState('');
  const [chargesCategory, setChargesCategory] = useState(categories[0]?.id ?? '');
  const [date, setDate] = useState(lookups.today);
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<Partial<Record<MoneyField, string>>>({});
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const places = [{ id: 'safe', name: placeName(lookups, 'safe') }, ...banks];
  const clear = (k: MoneyField) => setProblems((p) => (p[k] ? { ...p, [k]: undefined } : p));
  const submit = async () => {
    // Every problem at once, at its field (owner answer 6).
    const wrong: typeof problems = {};
    const value = moneyValue(amount, lookups.money.minorUnits);
    if (typeof value !== 'number' || value <= 0) wrong.amount = t('accounting.problems.amount_invalid');
    const fee = charges.trim() === '' ? 0 : moneyValue(charges, lookups.money.minorUnits);
    if (typeof fee !== 'number' || fee < 0) wrong.charges = t('accounting.problems.charges_invalid');
    if (kind === 'receipt' && !customer) wrong.customer = t('accounting.problems.customer_required');
    setProblems(wrong);
    if (Object.keys(wrong).length > 0 || typeof value !== 'number' || typeof fee !== 'number') return;
    const common = {
      amount: value,
      reference,
      note,
      allowDuplicate: duplicate,
    };
    const [url, body] =
      kind === 'receipt'
        ? [
            '/api/accounting/receipts',
            {
              ...common,
              customerId: customer!.id,
              bankAccountId: bank,
              receivedOn: date,
            },
          ]
        : kind === 'expense'
          ? ['/api/accounting/expenses', { ...common, categoryId: category, paidFrom: bank, paidOn: date }]
          : [
              '/api/accounting/transfers',
              {
                ...common,
                from,
                to,
                charges: fee,
                chargesCategoryId: fee > 0 ? chargesCategory : null,
                movedOn: date,
              },
            ];
    setBusy(true);
    const r = await api('POST', url, body);
    setBusy(false);
    if (r.status === 201) return onDone((r.body as { number: string }).number);
    if (r.status === 409 && (r.body as { error?: string }).error === 'possible_duplicate') {
      // Not a field's problem: a toast, and the main button becomes Save anyway.
      setDuplicate(true);
      return notify.problem(t('accounting.problems.possible_duplicate'));
    }
    const at = fieldProblems(t, r.body);
    if (at) setProblems(at);
    else notify.problem(accountingRefusal(t, r.body));
  };
  const options = (list: { id: string; name: string }[]) => list.map((b) => ({ value: b.id, label: b.name }));
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={t(`accounting.new.${kind}`)}
      description={t(`accounting.new.${kind}Help`)}
      actionLabel={duplicate ? t('accounting.new.saveAnyway') : t('accounting.new.save')}
      actionIcon={Save}
      cancelLabel={t('accounting.cancel')}
      busy={busy}
      size="lg"
      errors={problems}
      onSubmit={() => void submit()}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {kind === 'receipt' && (
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className={FIELD_LABEL}>{t('accounting.fields.customer')}</span>
            <PartyPicker
              api={api}
              label={t('accounting.fields.customer')}
              role="customer"
              picked={customer}
              error={problems.customer}
              onPick={(p) => {
                setCustomer(p);
                clear('customer');
              }}
            />
          </div>
        )}
        {kind === 'expense' && (
          <Select
            label={t('accounting.fields.category')}
            value={category}
            onValueChange={setCategory}
            options={options(categories)}
          />
        )}
        {kind !== 'transfer' && (
          <Select
            label={t(kind === 'receipt' ? 'accounting.fields.intoBank' : 'accounting.fields.paidFrom')}
            value={bank}
            onValueChange={setBank}
            options={options(kind === 'expense' ? places : banks)}
          />
        )}
        {kind === 'transfer' && (
          <>
            <Select
              label={t('accounting.fields.from')}
              value={from}
              onValueChange={setFrom}
              options={options(places)}
            />
            <Select
              label={t('accounting.fields.to')}
              value={to}
              onValueChange={setTo}
              options={options(places)}
            />
          </>
        )}
        <TextInput
          label={t('accounting.fields.amount')}
          error={problems.amount}
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setDuplicate(false);
            clear('amount');
          }}
        />
        <TextInput
          label={t('accounting.fields.date')}
          error={problems.date}
          type="date"
          value={date}
          max={lookups.today}
          onChange={(e) => {
            setDate(e.target.value);
            setDuplicate(false);
            clear('date');
          }}
        />
        {kind === 'transfer' && (
          <>
            <TextInput
              label={t('accounting.fields.charges')}
              error={problems.charges}
              inputMode="decimal"
              value={charges}
              onChange={(e) => {
                setCharges(e.target.value);
                clear('charges');
              }}
            />
            <Select
              label={t('accounting.fields.chargesCategory')}
              value={chargesCategory}
              onValueChange={setChargesCategory}
              options={options(categories)}
            />
          </>
        )}
        <TextInput
          label={t('accounting.fields.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <TextInput
          label={t('accounting.fields.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}
export function DocumentScreen({ api, type, id }: { api: Api; type: string; id: string }) {
  const { t } = useTranslation();
  const lookups = useAccountingLookups(api);
  const [version, setVersion] = useState(0);
  const [doc, setDoc] = useState<AccountingDocumentView | null | undefined>(undefined);
  const [reversing, setReversing] = useState(false);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/accounting/documents/${encodeURIComponent(type)}/${encodeURIComponent(id)}`).then(
      (r) => live && setDoc(r.status === 200 ? (r.body as AccountingDocumentView) : null),
    );
    return () => {
      live = false;
    };
  }, [api, type, id, version]);
  if (lookups === null || doc === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (doc === null) return <PageHeader title={t('accounting.document.notFound')} />;
  const m = lookups.money;
  return (
    <>
      <PageHeader
        eyebrow={
          <a href={href.money} className="underline-offset-4 hover:underline">
            {t('accounting.money.title')}
          </a>
        }
        title={`${t(`accounting.types.${doc.type}`)} ${doc.number ?? ''}`}
        help={
          doc.reverses ? t('accounting.money.reverses', { number: doc.reverses.number }) : doc.description
        }
        actions={
          doc.canReverse && (
            <Button variant="outline" icon={Undo2} onClick={() => setReversing(true)}>
              {t('accounting.document.reverse')}
            </Button>
          )
        }
      />
      <Panel className="grid grid-cols-1 gap-2 p-3.5 sm:grid-cols-4">
        <Fact label={t('accounting.fields.date')} value={doc.date} />
        <Fact label={t('accounting.fields.amount')} value={formatMoney(doc.amount, m)} />
        <Fact label={t('accounting.fields.reference')} value={doc.reference ?? '—'} />
        <Fact label={t('accounting.document.by')} value={doc.createdBy ?? '—'} />
        {doc.note && <Fact label={t('accounting.fields.note')} value={doc.note} />}
        {doc.reversedBy && (
          <div>
            <span className={FIELD_LABEL}>{t('accounting.fields.status')}</span>
            <p className="m-0">
              <a
                href={href.accountingDocument('journal_voucher', doc.reversedBy.id)}
                className="font-mono font-semibold underline-offset-4 hover:underline"
              >
                {t('accounting.status.reversed', { number: doc.reversedBy.number })}
              </a>
            </p>
          </div>
        )}
        {doc.reverses && (
          <div>
            <span className={FIELD_LABEL}>{t('accounting.document.reversesLabel')}</span>
            <p className="m-0">
              <a
                href={href.accountingDocument(doc.reverses.type, doc.reverses.id)}
                className="font-mono font-semibold underline-offset-4 hover:underline"
              >
                {doc.reverses.number}
              </a>
            </p>
          </div>
        )}
      </Panel>
      <Panel className="overflow-x-auto px-1.5 pb-2.5">
        <h2 className="m-0 px-2 pt-2 text-base font-semibold">
          {t('accounting.document.journal', { number: doc.journal.number ?? '' })}
        </h2>
        <Table aria-label={t('accounting.document.journal', { number: doc.journal.number ?? '' })}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('accounting.fields.account')}</TableHead>
              <TableHead>{t('accounting.fields.party')}</TableHead>
              <TableHead className="text-end">{t('accounting.fields.debit')}</TableHead>
              <TableHead className="text-end">{t('accounting.fields.credit')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {doc.journal.lines.map((l, i) => (
              <TableRow key={i}>
                <TableCell>
                  <a href={href.ledger(l.accountId)} className="underline-offset-4 hover:underline">
                    <span className="font-mono">{l.accountCode}</span> {l.accountName}
                  </a>
                  <LineEffectHint
                    lookups={lookups}
                    accountId={l.accountId}
                    partyName={l.partyName}
                    debit={l.debit}
                    credit={l.credit}
                  />
                </TableCell>
                <TableCell>{l.partyName ?? ''}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {l.debit ? formatMoney(l.debit, m) : ''}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {l.credit ? formatMoney(l.credit, m) : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      {reversing && (
        <ReverseDialog
          api={api}
          lookups={lookups}
          doc={doc}
          onOpenChange={setReversing}
          onDone={() => {
            setReversing(false);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className={FIELD_LABEL}>{label}</span>
      <p className="m-0">{value}</p>
    </div>
  );
}

function ReverseDialog({
  api,
  lookups,
  doc,
  onOpenChange,
  onDone,
}: {
  api: Api;
  lookups: AccountingLookups;
  doc: AccountingDocumentView;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState(lookups.today);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await api('POST', '/api/accounting/reverse', { type: doc.type, id: doc.id, date });
    setBusy(false);
    if (r.status === 201) return onDone();
    // A date problem shows at the date; anything else is a toast (owner answer 6).
    const at = fieldProblems(t, r.body);
    if (at?.date) setError(at.date);
    else notify.problem(accountingRefusal(t, r.body));
  };
  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={t('accounting.document.reverseTitle', { number: doc.number ?? '' })}
      description={t('accounting.document.reverseHelp')}
      actionLabel={t('accounting.document.reverse')}
      actionIcon={Undo2}
      cancelLabel={t('accounting.cancel')}
      busy={busy}
      size="sm"
      errors={{ date: error }}
      onSubmit={() => void submit()}
    >
      <TextInput
        label={t('accounting.fields.date')}
        error={error}
        type="date"
        value={date}
        min={doc.date}
        max={lookups.today}
        onChange={(e) => {
          setDate(e.target.value);
          setError(undefined);
        }}
      />
    </FormDialog>
  );
}
