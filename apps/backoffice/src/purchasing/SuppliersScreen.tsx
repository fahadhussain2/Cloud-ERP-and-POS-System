import type { PurchasingLookups, SupplierDetail, SupplierRow } from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  formatMoney,
  Input,
  LABEL_CLASS,
  PageHeader,
  Panel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextField,
} from '@erp/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyValue } from '../catalog/data';
import { href, navigate } from '../router';
import { dateProblem, purchasingRefusal, usePurchasingLookups } from './data';
import { FormDialog } from '../staff/dialogs';

// Suppliers (W1-16, PUR-01, PUR-09): the list with what the shop owes each, a supplier's details (terms, the label
// abbreviation for W1-17), the ledger with its running balance, and a payment by bank (owner and accountant, owner
// answer 2). Cash is paid at the desk (owner answer 1). Add, Edit, Pay by bank, Deactivate and Delete open as dialogs
// (owner review, 2026-11-07); Delete only for a supplier never used, Deactivate only when nothing is owed.

export function SuppliersScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [text, setText] = useState('');
  const [list, setList] = useState<SupplierRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const searchId = useId();

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api('GET', `/api/purchasing/suppliers?q=${encodeURIComponent(text)}`).then(
        (r) => live && setList(r.status === 200 ? (r.body as { suppliers: SupplierRow[] }).suppliers : []),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, text, version]);
  const reload = () => setVersion((v) => v + 1);

  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const canAct = lookups.can.receive;
  return (
    <>
      <PageHeader
        title={t('purchasing.suppliers.title')}
        help={t('purchasing.suppliers.help')}
        actions={
          canAct && (
            <Button size="lg" onClick={() => setAdding(true)}>
              {t('purchasing.suppliers.add')}
            </Button>
          )
        }
      />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <SupplierDialog
        api={api}
        open={adding}
        onOpenChange={setAdding}
        onDone={(id) => {
          setAdding(false);
          if (id) navigate(href.supplier(id));
        }}
      />
      <Panel className="flex flex-col gap-1 p-3.5">
        <label htmlFor={searchId} className={LABEL_CLASS}>
          {t('purchasing.suppliers.search')}
        </label>
        <Input
          id={searchId}
          type="search"
          className="h-10 max-w-md"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        {list === null ? (
          <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
        ) : list.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('purchasing.suppliers.empty')}</p>
        ) : (
          <Table aria-label={t('purchasing.suppliers.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('purchasing.fields.code')}</TableHead>
                <TableHead>{t('purchasing.fields.name')}</TableHead>
                <TableHead>{t('purchasing.fields.terms')}</TableHead>
                <TableHead>{t('purchasing.fields.labelAbbr')}</TableHead>
                <TableHead className="text-end">{t('purchasing.suppliers.owed')}</TableHead>
                {canAct && (
                  <TableHead>
                    <span className="sr-only">{t('purchasing.suppliers.actions')}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono">{s.code}</TableCell>
                  <TableCell>
                    <a
                      href={href.supplier(s.id)}
                      className="font-semibold text-ink underline-offset-4 hover:underline"
                    >
                      {s.name}
                    </a>
                    {s.status === 'inactive' && (
                      <span className="ms-2 inline-block">
                        <StatusChip tone="neutral">{t('purchasing.suppliers.inactive')}</StatusChip>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {s.termsDays === null ? '—' : t('purchasing.suppliers.days', { count: s.termsDays })}
                  </TableCell>
                  <TableCell className="font-mono">{s.labelAbbr ?? '—'}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatMoney(s.balance, lookups.money)}
                  </TableCell>
                  {canAct && (
                    <TableCell className="text-end">
                      <SupplierActions
                        api={api}
                        row={s}
                        money={lookups.money}
                        onDone={(done) => {
                          setMessage(done);
                          reload();
                        }}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}

type Action = 'edit' | 'status' | 'delete';

/**
 * A row's Edit, Deactivate or Reactivate, and Delete (a supplier never used only). Each opens a dialog; Edit and the
 * status change read the supplier first, for its details and row version.
 */
function SupplierActions({
  api,
  row,
  money,
  onDone,
}: {
  api: Api;
  row: SupplierRow;
  money: PurchasingLookups['money'];
  onDone: (message: { text: string; error: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Action | null>(null);
  const [supplier, setSupplier] = useState<SupplierDetail['supplier'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exists = (k: string) => t(k) !== k;

  const start = async (action: Action) => {
    setError(null);
    if (action !== 'delete') {
      const r = await api('GET', `/api/purchasing/suppliers/${encodeURIComponent(row.id)}`);
      if (r.status !== 200) return onDone({ text: purchasingRefusal(t, exists, r.body), error: true });
      setSupplier((r.body as SupplierDetail).supplier);
    }
    setOpen(action);
  };
  const close = () => setOpen(null);
  const deactivating = row.status === 'active';
  const statusLabel = t(deactivating ? 'purchasing.suppliers.deactivate' : 'purchasing.suppliers.reactivate');

  const changeStatus = async () => {
    if (!supplier) return;
    setBusy(true);
    const r = await api('PATCH', `/api/purchasing/suppliers/${encodeURIComponent(row.id)}`, {
      rowVersion: supplier.rowVersion,
      status: deactivating ? 'inactive' : 'active',
    });
    setBusy(false);
    if (r.status !== 200) return setError(purchasingRefusal(t, exists, r.body, money));
    close();
    onDone({
      text: t(deactivating ? 'purchasing.suppliers.deactivated' : 'purchasing.suppliers.reactivated', {
        name: row.name,
      }),
      error: false,
    });
  };
  const remove = async () => {
    setBusy(true);
    const r = await api('DELETE', `/api/purchasing/suppliers/${encodeURIComponent(row.id)}`);
    setBusy(false);
    if (r.status !== 200) return setError(purchasingRefusal(t, exists, r.body, money));
    close();
    onDone({ text: t('purchasing.suppliers.deleted', { name: row.name }), error: false });
  };

  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      <Button
        size="sm"
        variant="outline"
        aria-label={`${t('purchasing.suppliers.edit')} ${row.name}`}
        onClick={() => void start('edit')}
      >
        {t('purchasing.suppliers.edit')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${statusLabel} ${row.name}`}
        onClick={() => void start('status')}
      >
        {statusLabel}
      </Button>
      {row.deletable && (
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          aria-label={`${t('purchasing.suppliers.delete')} ${row.name}`}
          onClick={() => void start('delete')}
        >
          {t('purchasing.suppliers.delete')}
        </Button>
      )}
      {supplier && (
        <SupplierDialog
          api={api}
          supplier={supplier}
          open={open === 'edit'}
          onOpenChange={(o) => !o && close()}
          onDone={() => {
            close();
            onDone({ text: t('purchasing.suppliers.saved', { name: row.name }), error: false });
          }}
        />
      )}
      <FormDialog
        open={open === 'status'}
        onOpenChange={(o) => !o && close()}
        title={t(
          deactivating ? 'purchasing.suppliers.deactivateTitle' : 'purchasing.suppliers.reactivateTitle',
          {
            name: row.name,
          },
        )}
        description={t(
          deactivating ? 'purchasing.suppliers.deactivateText' : 'purchasing.suppliers.reactivateText',
        )}
        actionLabel={t(deactivating ? 'purchasing.suppliers.deactivate' : 'purchasing.suppliers.reactivate')}
        cancelLabel={t('purchasing.cancel')}
        busy={busy}
        onSubmit={() => void changeStatus()}
      >
        <ErrorText text={error} />
      </FormDialog>
      <FormDialog
        open={open === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={t('purchasing.suppliers.deleteTitle', { name: row.name })}
        description={t('purchasing.suppliers.deleteText')}
        actionLabel={t('purchasing.suppliers.delete')}
        cancelLabel={t('purchasing.cancel')}
        busy={busy}
        onSubmit={() => void remove()}
      >
        <ErrorText text={error} />
      </FormDialog>
    </span>
  );
}

function ErrorText({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="m-0 text-sm text-destructive">
      {text}
    </p>
  ) : null;
}

/** A new supplier, or a supplier's details, in a dialog. */
function SupplierDialog({
  api,
  supplier,
  open,
  onOpenChange,
  onDone,
}: {
  api: Api;
  supplier?: SupplierDetail['supplier'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const blank = () => ({
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phones: supplier?.phones.join(', ') ?? '',
    address: supplier?.address ?? '',
    termsDays: supplier?.termsDays === null || supplier === undefined ? '' : String(supplier.termsDays),
    labelAbbr: supplier?.labelAbbr ?? '',
  });
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async () => {
    const terms = f.termsDays.trim() === '' ? null : Number(f.termsDays);
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365))
      return setError(t('purchasing.problems.terms'));
    const body = {
      name: f.name,
      contactPerson: f.contactPerson,
      phones: f.phones
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      address: f.address,
      termsDays: terms,
      labelAbbr: f.labelAbbr,
    };
    setBusy(true);
    const r = supplier
      ? await api('PATCH', `/api/purchasing/suppliers/${encodeURIComponent(supplier.id)}`, {
          ...body,
          rowVersion: supplier.rowVersion,
        })
      : await api('POST', '/api/purchasing/suppliers', { ...body, code: f.code });
    setBusy(false);
    if (r.status === 200 || r.status === 201) {
      setF(blank());
      setError(null);
      return onDone(r.status === 201 ? (r.body as { id: string }).id : (supplier?.id ?? null));
    }
    setError(purchasingRefusal(t, (k) => t(k) !== k, r.body));
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title={supplier ? t('purchasing.suppliers.details') : t('purchasing.suppliers.add')}
      actionLabel={supplier ? t('purchasing.suppliers.save') : t('purchasing.suppliers.create')}
      cancelLabel={t('purchasing.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        {!supplier && (
          <TextField
            label={t('purchasing.fields.code')}
            value={f.code}
            onChange={(e) => set('code', e.target.value)}
          />
        )}
        <TextField
          label={t('purchasing.fields.name')}
          value={f.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <TextField
          label={t('purchasing.fields.contact')}
          value={f.contactPerson}
          onChange={(e) => set('contactPerson', e.target.value)}
        />
        <TextField
          label={t('purchasing.fields.phones')}
          hint={t('purchasing.fields.phonesHint')}
          value={f.phones}
          onChange={(e) => set('phones', e.target.value)}
        />
        <TextField
          label={t('purchasing.fields.address')}
          value={f.address}
          onChange={(e) => set('address', e.target.value)}
        />
        <TextField
          label={t('purchasing.fields.terms')}
          inputMode="numeric"
          value={f.termsDays}
          onChange={(e) => set('termsDays', e.target.value)}
        />
        <TextField
          label={t('purchasing.fields.labelAbbr')}
          hint={t('purchasing.fields.labelAbbrHint')}
          value={f.labelAbbr}
          onChange={(e) => set('labelAbbr', e.target.value)}
        />
      </div>
      <ErrorText text={error} />
    </FormDialog>
  );
}

const KIND_KEYS: Record<string, string> = {
  goods_receipt: 'purchasing.ledger.goods_receipt',
  purchase_return: 'purchasing.ledger.purchase_return',
  supplier_payment: 'purchasing.ledger.supplier_payment',
  cash_movement: 'purchasing.ledger.cash_movement',
  opening: 'purchasing.ledger.opening',
};

export function SupplierScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [detail, setDetail] = useState<SupplierDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/purchasing/suppliers/${encodeURIComponent(id)}`).then(
      (r) => live && setDetail(r.status === 200 ? (r.body as SupplierDetail) : null),
    );
    return () => {
      live = false;
    };
  }, [api, id, version]);
  const load = () => setVersion((v) => v + 1);

  const back = (
    <a
      href={href.suppliers}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('purchasing.suppliers.title')}
    </a>
  );
  if (detail === undefined || lookups === null)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (detail === null) return <PageHeader eyebrow={back} title={t('purchasing.suppliers.notFound')} />;
  const m = lookups.money;
  const s = detail.supplier;
  return (
    <>
      <PageHeader
        eyebrow={back}
        title={s.name}
        help={t('purchasing.suppliers.owes', { amount: formatMoney(detail.balance, m) })}
        actions={
          <span className="flex flex-wrap gap-2">
            {lookups.can.receive && (
              <Button variant="outline" onClick={() => setEditing(true)}>
                {t('purchasing.suppliers.edit')}
              </Button>
            )}
            {lookups.can.payByBank && (
              <Button onClick={() => setPaying(true)}>{t('purchasing.pay.action')}</Button>
            )}
          </span>
        }
      />
      {message && (
        <Alert>
          <AlertDescription role="status">{message}</AlertDescription>
        </Alert>
      )}
      <SupplierDialog
        key={`edit-${s.rowVersion}`}
        api={api}
        supplier={s}
        open={editing}
        onOpenChange={setEditing}
        onDone={() => {
          setEditing(false);
          load();
        }}
      />
      <PayDialog
        api={api}
        lookups={lookups}
        supplierId={s.id}
        open={paying}
        onOpenChange={setPaying}
        onDone={(number) => {
          setPaying(false);
          setMessage(t('purchasing.pay.done', { number }));
          load();
        }}
      />
      <Panel className="flex flex-wrap gap-x-8 gap-y-2 p-3.5 text-sm">
        <span>
          <span className={LABEL_CLASS}>{t('purchasing.fields.code')}</span>{' '}
          <span className="font-mono">{s.code}</span>
        </span>
        <span>
          <span className={LABEL_CLASS}>{t('purchasing.fields.terms')}</span>{' '}
          {s.termsDays === null ? '—' : t('purchasing.suppliers.days', { count: s.termsDays })}
        </span>
        <span>
          <span className={LABEL_CLASS}>{t('purchasing.fields.labelAbbr')}</span> {s.labelAbbr ?? '—'}
        </span>
        <span>
          <span className={LABEL_CLASS}>{t('purchasing.fields.phones')}</span> {s.phones.join(', ') || '—'}
        </span>
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <h2 className="m-0 px-2 pt-3 font-display text-lg font-semibold">{t('purchasing.ledger.title')}</h2>
        {detail.ledger.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('purchasing.ledger.empty')}</p>
        ) : (
          <Table aria-label={t('purchasing.ledger.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('purchasing.ledger.date')}</TableHead>
                <TableHead>{t('purchasing.ledger.document')}</TableHead>
                <TableHead>{t('purchasing.ledger.due')}</TableHead>
                <TableHead className="text-end">{t('purchasing.ledger.amount')}</TableHead>
                <TableHead className="text-end">{t('purchasing.ledger.balance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.ledger.map((e, n) => (
                <TableRow key={n}>
                  <TableCell>{e.entryDate}</TableCell>
                  <TableCell>
                    {t(KIND_KEYS[e.kind] ?? 'purchasing.ledger.other')}{' '}
                    {e.kind === 'goods_receipt' ? (
                      <a
                        href={href.receipt(e.sourceId)}
                        className="font-mono underline-offset-4 hover:underline"
                      >
                        {e.number}
                      </a>
                    ) : e.kind === 'purchase_return' ? (
                      <a
                        href={href.purchaseReturn(e.sourceId)}
                        className="font-mono underline-offset-4 hover:underline"
                      >
                        {e.number}
                      </a>
                    ) : (
                      <span className="font-mono">{e.number}</span>
                    )}
                  </TableCell>
                  <TableCell>{e.amount > 0 ? e.dueDate : '—'}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatMoney(e.amount, m)}</TableCell>
                  <TableCell className="text-end tabular-nums">{formatMoney(e.balance, m)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}

function PayDialog({
  api,
  lookups,
  supplierId,
  open,
  onOpenChange,
  onDone,
}: {
  api: Api;
  lookups: PurchasingLookups;
  supplierId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (number: string) => void;
}) {
  const { t } = useTranslation();
  const [bank, setBank] = useState(lookups.bankAccounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(lookups.today);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bankId = useId();
  // A payment dated after the shop's business date (W2-05) or on or before the lock date (D-108) can't post: the date
  // says why before it is sent.
  const locked = dateProblem(t, paidOn, lookups);
  const submit = async () => {
    if (locked) return setError(locked);
    const value = moneyValue(amount, lookups.money.minorUnits);
    if (typeof value !== 'number' || value <= 0) return setError(t('purchasing.problems.amount'));
    setBusy(true);
    const r = await api('POST', '/api/purchasing/payments', {
      supplierId,
      bankAccountId: bank,
      amount: value,
      paidOn,
      reference,
    });
    setBusy(false);
    if (r.status === 201) {
      setAmount('');
      setReference('');
      setError(null);
      return onDone((r.body as { number: string }).number);
    }
    setError(purchasingRefusal(t, (k) => t(k) !== k, r.body));
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title={t('purchasing.pay.title')}
      actionLabel={t('purchasing.pay.confirm')}
      cancelLabel={t('purchasing.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={bankId} className={LABEL_CLASS}>
            {t('purchasing.pay.bank')}
          </label>
          <select
            id={bankId}
            className="h-11 rounded-md border border-input bg-surface-2 px-2"
            value={bank}
            onChange={(e) => setBank(e.target.value)}
          >
            {lookups.bankAccounts.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t('purchasing.pay.amount')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <TextField
          label={t('purchasing.pay.date')}
          type="date"
          error={locked}
          max={lookups.today}
          value={paidOn}
          onChange={(e) => setPaidOn(e.target.value)}
        />
        <TextField
          label={t('purchasing.pay.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
      <ErrorText text={error} />
    </FormDialog>
  );
}
