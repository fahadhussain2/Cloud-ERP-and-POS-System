import type { CustomerDetail, CustomerLookups, CustomerRow } from '@erp/contracts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  formatMoney,
  Input,
  LABEL_CLASS,
  PageHeader,
  Panel,
  plainAmount,
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
import { FormDialog } from '../staff/dialogs';
import { customerRefusal, phoneToCheck, useCustomerLookups } from './data';

// Customers (W1-22, D-109; POS-05, POS-07, CAT-04, PUR-01, ACC-03): the list with what each customer owes, Add and
// Edit as dialogs (as the suppliers screen, D-105), Deactivate only at a zero balance and Delete only one never used
// (owner answer 5), and a customer's page with the ledger (owner answer 7). The tier and credit terms are the owner's
// (cust.terms.edit, owner answer 2); everyone else sees them read only. Phones are shown in full here (staff only).

type Status = '' | 'active' | 'inactive';

export function CustomersScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = useCustomerLookups(api);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('active');
  const [list, setList] = useState<CustomerRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const searchId = useId();
  const statusId = useId();

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void api('GET', `/api/customers?q=${encodeURIComponent(text)}&status=${status}`).then(
        (r) => live && setList(r.status === 200 ? (r.body as { customers: CustomerRow[] }).customers : []),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, text, status, version]);
  const reload = () => setVersion((v) => v + 1);

  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const m = lookups.money;
  const canEdit = lookups.can.edit;
  return (
    <>
      <PageHeader
        title={t('customers.title')}
        help={t('customers.help')}
        actions={
          canEdit && (
            <Button size="lg" onClick={() => setAdding(true)}>
              {t('customers.add')}
            </Button>
          )
        }
      />
      {message && (
        <Alert variant={message.error ? 'destructive' : 'default'}>
          <AlertDescription role={message.error ? 'alert' : 'status'}>{message.text}</AlertDescription>
        </Alert>
      )}
      <CustomerDialog
        api={api}
        lookups={lookups}
        open={adding}
        onOpenChange={setAdding}
        onDone={(id) => {
          setAdding(false);
          if (id) navigate(href.customer(id));
        }}
      />
      <Panel className="flex flex-wrap items-end gap-3 p-3.5">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <label htmlFor={searchId} className={LABEL_CLASS}>
            {t('customers.search')}
          </label>
          <Input
            id={searchId}
            type="search"
            className="h-10 max-w-md"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={statusId} className={LABEL_CLASS}>
            {t('customers.show')}
          </label>
          <select
            id={statusId}
            className="h-10 rounded-md border border-input bg-surface-2 px-2"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
          >
            <option value="active">{t('customers.active')}</option>
            <option value="inactive">{t('customers.inactive')}</option>
            <option value="">{t('customers.all')}</option>
          </select>
        </div>
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        {list === null ? (
          <p className="p-2 text-muted-foreground">{t('app.loading')}</p>
        ) : list.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('customers.empty')}</p>
        ) : (
          <Table aria-label={t('customers.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('customers.fields.code')}</TableHead>
                <TableHead>{t('customers.fields.name')}</TableHead>
                <TableHead>{t('customers.fields.city')}</TableHead>
                <TableHead>{t('customers.fields.phone')}</TableHead>
                <TableHead>{t('customers.fields.tier')}</TableHead>
                <TableHead>{t('customers.fields.credit')}</TableHead>
                <TableHead className="text-end">{t('customers.owed')}</TableHead>
                {canEdit && (
                  <TableHead>
                    <span className="sr-only">{t('customers.actions')}</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono">{c.code}</TableCell>
                  <TableCell>
                    <a
                      href={href.customer(c.id)}
                      className="font-semibold text-ink underline-offset-4 hover:underline"
                    >
                      {c.name}
                    </a>
                    {c.status === 'inactive' && (
                      <span className="ms-2 inline-block">
                        <StatusChip tone="neutral">{t('customers.inactive')}</StatusChip>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{c.city ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">{c.phones[0] ?? '—'}</TableCell>
                  <TableCell>{c.tierName}</TableCell>
                  <TableCell>
                    <CreditText row={c} money={m} />
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatMoney(c.balance, m)}</TableCell>
                  {canEdit && (
                    <TableCell className="text-end">
                      <CustomerActions
                        api={api}
                        lookups={lookups}
                        row={c}
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

function CreditText({ row, money }: { row: CustomerRow; money: CustomerLookups['money'] }) {
  const { t } = useTranslation();
  if (!row.creditAllowed) return <>{t('customers.noCredit')}</>;
  if (row.creditLimit === null) return <>{t('customers.noLimit')}</>;
  return <>{t('customers.limitOf', { amount: formatMoney(row.creditLimit, money) })}</>;
}

type Action = 'edit' | 'status' | 'delete';

/** A row's Edit, Deactivate or Reactivate, and Delete (never used only); each reads the customer first. */
function CustomerActions({
  api,
  lookups,
  row,
  onDone,
}: {
  api: Api;
  lookups: CustomerLookups;
  row: CustomerRow;
  onDone: (message: { text: string; error: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Action | null>(null);
  const [customer, setCustomer] = useState<CustomerDetail['customer'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (action: Action) => {
    setError(null);
    if (action !== 'delete') {
      const r = await api('GET', `/api/customers/${encodeURIComponent(row.id)}`);
      if (r.status !== 200) return onDone({ text: customerRefusal(t, r.body), error: true });
      setCustomer((r.body as CustomerDetail).customer);
    }
    setOpen(action);
  };
  const close = () => setOpen(null);
  const deactivating = row.status === 'active';
  const statusLabel = t(deactivating ? 'customers.deactivate' : 'customers.reactivate');

  const changeStatus = async () => {
    if (!customer) return;
    setBusy(true);
    const r = await api('PATCH', `/api/customers/${encodeURIComponent(row.id)}`, {
      rowVersion: customer.rowVersion,
      status: deactivating ? 'inactive' : 'active',
    });
    setBusy(false);
    if (r.status !== 200) return setError(customerRefusal(t, r.body, lookups.money));
    close();
    onDone({
      text: t(deactivating ? 'customers.deactivated' : 'customers.reactivated', { name: row.name }),
      error: false,
    });
  };
  const remove = async () => {
    setBusy(true);
    const r = await api('DELETE', `/api/customers/${encodeURIComponent(row.id)}`);
    setBusy(false);
    if (r.status !== 200) return setError(customerRefusal(t, r.body, lookups.money));
    close();
    onDone({ text: t('customers.deleted', { name: row.name }), error: false });
  };

  return (
    <span className="inline-flex flex-wrap justify-end gap-1">
      <Button
        size="sm"
        variant="outline"
        aria-label={`${t('customers.edit')} ${row.name}`}
        onClick={() => void start('edit')}
      >
        {t('customers.edit')}
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
          aria-label={`${t('customers.delete')} ${row.name}`}
          onClick={() => void start('delete')}
        >
          {t('customers.delete')}
        </Button>
      )}
      {customer && (
        <CustomerDialog
          key={customer.rowVersion}
          api={api}
          lookups={lookups}
          customer={customer}
          open={open === 'edit'}
          onOpenChange={(o) => !o && close()}
          onDone={() => {
            close();
            onDone({ text: t('customers.saved', { name: row.name }), error: false });
          }}
        />
      )}
      <FormDialog
        open={open === 'status'}
        onOpenChange={(o) => !o && close()}
        title={t(deactivating ? 'customers.deactivateTitle' : 'customers.reactivateTitle', {
          name: row.name,
        })}
        description={t(deactivating ? 'customers.deactivateText' : 'customers.reactivateText')}
        actionLabel={statusLabel}
        cancelLabel={t('customers.cancel')}
        busy={busy}
        onSubmit={() => void changeStatus()}
      >
        <ErrorText text={error} />
      </FormDialog>
      <FormDialog
        open={open === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={t('customers.deleteTitle', { name: row.name })}
        description={t('customers.deleteText')}
        actionLabel={t('customers.delete')}
        cancelLabel={t('customers.cancel')}
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

const SELECT_CLASS = 'h-11 rounded-md border border-input bg-surface-2 px-2';

/** A new customer (or an existing supplier made one), or a customer's details and terms, in a dialog. */
export function CustomerDialog({
  api,
  lookups,
  customer,
  open,
  onOpenChange,
  onDone,
}: {
  api: Api;
  lookups: CustomerLookups;
  customer?: CustomerDetail['customer'];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const minor = lookups.money.minorUnits;
  const defaultTier = lookups.tiers.find((x) => x.isDefault)?.id ?? lookups.tiers[0]?.id ?? '';
  const blank = () => ({
    source: 'new' as 'new' | 'supplier',
    supplierId: lookups.suppliers[0]?.id ?? '',
    code: '',
    name: customer?.name ?? '',
    phones: customer?.phones.join(', ') ?? '',
    city: customer?.city ?? '',
    contactPerson: customer?.contactPerson ?? '',
    address: customer?.address ?? '',
    notes: customer?.notes ?? '',
    tierId: customer?.tierId ?? defaultTier,
    creditAllowed: customer?.creditAllowed ?? false,
    noLimit: customer !== undefined && customer.creditAllowed && customer.creditLimit === null,
    limit: customer?.creditLimit == null ? '' : plainAmount(customer.creditLimit, minor),
    cap: plainAmount(customer?.offlineDailyCap ?? lookups.defaultOfflineDailyCap, minor),
    termsDays: customer?.termsDays == null ? '' : String(customer.termsDays),
  });
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ check: string; row: CustomerRow | null } | null>(null);
  const tierId = useId();
  const sourceId = useId();
  const supplierPick = useId();
  const set = <K extends keyof ReturnType<typeof blank>>(k: K, v: ReturnType<typeof blank>[K]) =>
    setF((x) => ({ ...x, [k]: v }));
  const canTerms = lookups.can.terms;
  const fromSupplier = !customer && f.source === 'supplier';

  // A new customer's code is suggested (owner answer 4), and changes nothing once saved.
  useEffect(() => {
    if (!open || customer) return;
    let live = true;
    void api('GET', '/api/customers/next-code').then((r) => {
      if (live && r.status === 200)
        setF((x) => (x.code === '' ? { ...x, code: (r.body as { code: string }).code } : x));
    });
    return () => {
      live = false;
    };
  }, [api, open, customer]);

  // The duplicate hint: another customer with the phone being typed (never blocks the save).
  const check = phoneToCheck(f.phones);
  useEffect(() => {
    if (!open || check === null) return;
    let live = true;
    const timer = setTimeout(() => {
      void api('GET', `/api/customers?q=${check}`).then((r) => {
        if (!live || r.status !== 200) return;
        const found = (r.body as { customers: CustomerRow[] }).customers.find((x) => x.id !== customer?.id);
        setFound({ check, row: found ?? null });
      });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, open, check, customer?.id]);
  const twin = open && found !== null && found.check === check ? found.row : null;

  const terms = () => {
    const days = f.termsDays.trim() === '' ? null : Number(f.termsDays);
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365))
      return t('customers.problems.terms');
    const cap = moneyValue(f.cap, minor);
    if (typeof cap !== 'number' || cap < 0) return t('customers.problems.amount');
    let limit: number | null = null;
    if (f.creditAllowed && !f.noLimit) {
      const v = moneyValue(f.limit, minor);
      if (v === null) return t('customers.problems.limit');
      if (v === undefined || v < 0) return t('customers.problems.amount');
      limit = v;
    }
    return {
      tierId: f.tierId,
      creditAllowed: f.creditAllowed,
      creditLimit: limit,
      noLimit: f.creditAllowed && f.noLimit,
      offlineDailyCap: cap,
      termsDays: days,
    };
  };

  const submit = async () => {
    let body: Record<string, unknown>;
    if (fromSupplier) body = { partyId: f.supplierId };
    else
      body = {
        name: f.name,
        phones: f.phones
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
        city: f.city,
        contactPerson: f.contactPerson,
        address: f.address,
        notes: f.notes,
      };
    if (canTerms) {
      const tm = terms();
      if (typeof tm === 'string') return setError(tm);
      body['terms'] = tm;
    }
    setBusy(true);
    const r = customer
      ? await api('PATCH', `/api/customers/${encodeURIComponent(customer.id)}`, {
          ...body,
          rowVersion: customer.rowVersion,
          ...(canTerms ? { accountVersion: customer.accountVersion } : {}),
        })
      : await api('POST', '/api/customers', fromSupplier ? body : { ...body, code: f.code });
    setBusy(false);
    if (r.status === 200 || r.status === 201) {
      setF(blank());
      setError(null);
      return onDone(r.status === 201 ? (r.body as { id: string }).id : (customer?.id ?? null));
    }
    setError(customerRefusal(t, r.body, lookups.money));
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      title={customer ? t('customers.details') : t('customers.add')}
      actionLabel={customer ? t('customers.save') : t('customers.create')}
      cancelLabel={t('customers.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      {!customer && lookups.suppliers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={sourceId} className={LABEL_CLASS}>
            {t('customers.source.label')}
          </label>
          <select
            id={sourceId}
            className={SELECT_CLASS}
            value={f.source}
            onChange={(e) => set('source', e.target.value as 'new' | 'supplier')}
          >
            <option value="new">{t('customers.source.new')}</option>
            <option value="supplier">{t('customers.source.supplier')}</option>
          </select>
        </div>
      )}
      {fromSupplier ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={supplierPick} className={LABEL_CLASS}>
            {t('customers.source.pick')}
          </label>
          <select
            id={supplierPick}
            className={SELECT_CLASS}
            value={f.supplierId}
            onChange={(e) => set('supplierId', e.target.value)}
          >
            {lookups.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="grid gap-3.5 sm:grid-cols-2">
          {!customer && (
            <TextField
              label={t('customers.fields.code')}
              hint={t('customers.fields.codeHint')}
              value={f.code}
              onChange={(e) => set('code', e.target.value)}
            />
          )}
          <TextField
            label={t('customers.fields.name')}
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <TextField
            label={t('customers.fields.phones')}
            hint={t('customers.fields.phonesHint')}
            inputMode="tel"
            value={f.phones}
            onChange={(e) => set('phones', e.target.value)}
          />
          <TextField
            label={t('customers.fields.city')}
            value={f.city}
            onChange={(e) => set('city', e.target.value)}
          />
          <TextField
            label={t('customers.fields.contact')}
            value={f.contactPerson}
            onChange={(e) => set('contactPerson', e.target.value)}
          />
          <TextField
            label={t('customers.fields.address')}
            value={f.address}
            onChange={(e) => set('address', e.target.value)}
          />
          <div className="sm:col-span-2">
            <TextField
              label={t('customers.fields.notes')}
              value={f.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>
      )}
      {twin && (
        <p role="status" className="m-0 text-sm text-warn">
          {t('customers.phoneUsed', { code: twin.code, name: twin.name })}
        </p>
      )}
      <fieldset className="m-0 grid gap-3.5 border-0 p-0 sm:grid-cols-2" disabled={!canTerms}>
        <legend className="mb-1 text-sm font-semibold">{t('customers.fields.credit')}</legend>
        {!canTerms && (
          <p className="m-0 text-sm text-muted-foreground sm:col-span-2">{t('customers.termsLocked')}</p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={tierId} className={LABEL_CLASS}>
            {t('customers.fields.tier')}
          </label>
          <select
            id={tierId}
            className={SELECT_CLASS}
            disabled={!canTerms}
            value={f.tierId}
            onChange={(e) => set('tierId', e.target.value)}
          >
            {lookups.tiers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t('customers.fields.terms')}
          inputMode="numeric"
          value={f.termsDays}
          onChange={(e) => set('termsDays', e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={f.creditAllowed}
            onChange={(e) => set('creditAllowed', e.target.checked)}
          />
          {t('customers.fields.creditAllowed')}
        </label>
        {f.creditAllowed && (
          <>
            <TextField
              label={t('customers.fields.limit')}
              inputMode="decimal"
              disabled={f.noLimit || !canTerms}
              value={f.noLimit ? '' : f.limit}
              onChange={(e) => set('limit', e.target.value)}
            />
            <label className="flex items-center gap-2 self-end pb-3 text-sm">
              <input type="checkbox" checked={f.noLimit} onChange={(e) => set('noLimit', e.target.checked)} />
              {t('customers.fields.noLimit')}
            </label>
            <TextField
              label={t('customers.fields.cap')}
              hint={t('customers.fields.capHint')}
              inputMode="decimal"
              value={f.cap}
              onChange={(e) => set('cap', e.target.value)}
            />
          </>
        )}
      </fieldset>
      <ErrorText text={error} />
    </FormDialog>
  );
}

const LEDGER_KINDS = new Set([
  'sale',
  'sales_void',
  'payment',
  'customer_receipt',
  'journal_voucher',
  'opening',
]);

export function CustomerScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = useCustomerLookups(api);
  const [detail, setDetail] = useState<CustomerDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/customers/${encodeURIComponent(id)}`).then(
      (r) => live && setDetail(r.status === 200 ? (r.body as CustomerDetail) : null),
    );
    return () => {
      live = false;
    };
  }, [api, id, version]);

  const back = (
    <a
      href={href.customers}
      className="text-sm font-medium text-muted-foreground underline-offset-4 hover:underline"
    >
      ← {t('customers.title')}
    </a>
  );
  if (detail === undefined || lookups === null)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (detail === null) return <PageHeader eyebrow={back} title={t('customers.notFound')} />;
  const m = lookups.money;
  const c = detail.customer;
  return (
    <>
      <PageHeader
        eyebrow={back}
        title={c.name}
        help={t('customers.owes', { amount: formatMoney(detail.balance, m) })}
        actions={
          lookups.can.edit && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              {t('customers.edit')}
            </Button>
          )
        }
      />
      {c.imported && !lookups.live && (
        <Alert>
          <AlertTitle>{t('customers.notLive.title')}</AlertTitle>
          <AlertDescription>{t('customers.notLive.text')}</AlertDescription>
        </Alert>
      )}
      <CustomerDialog
        key={`edit-${c.rowVersion}-${c.accountVersion}`}
        api={api}
        lookups={lookups}
        customer={c}
        open={editing}
        onOpenChange={setEditing}
        onDone={() => {
          setEditing(false);
          setVersion((v) => v + 1);
        }}
      />
      <Panel className="flex flex-wrap gap-x-8 gap-y-2 p-3.5 text-sm">
        <Fact label={t('customers.fields.code')}>
          <span className="font-mono">{c.code}</span>
        </Fact>
        <Fact label={t('customers.fields.status')}>
          {t(c.status === 'active' ? 'customers.active' : 'customers.inactive')}
          {c.supplier && ` · ${t('customers.supplierToo')}`}
        </Fact>
        <Fact label={t('customers.fields.phones')}>{c.phones.join(', ') || '—'}</Fact>
        <Fact label={t('customers.fields.city')}>{c.city ?? '—'}</Fact>
        <Fact label={t('customers.fields.tier')}>{c.tierName}</Fact>
        <Fact label={t('customers.fields.credit')}>
          <CreditText row={c} money={m} />
        </Fact>
        {c.creditAllowed && (
          <Fact label={t('customers.fields.cap')}>{formatMoney(c.offlineDailyCap, m)}</Fact>
        )}
        <Fact label={t('customers.fields.terms')}>{c.termsDays ?? '—'}</Fact>
        {c.contactPerson && <Fact label={t('customers.fields.contact')}>{c.contactPerson}</Fact>}
        {c.address && <Fact label={t('customers.fields.address')}>{c.address}</Fact>}
        {c.notes && <Fact label={t('customers.fields.notes')}>{c.notes}</Fact>}
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <h2 className="m-0 px-2 pt-3 font-display text-lg font-semibold">{t('customers.ledger.title')}</h2>
        {detail.ledger.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('customers.ledger.empty')}</p>
        ) : (
          <Table aria-label={t('customers.ledger.title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('customers.ledger.date')}</TableHead>
                <TableHead>{t('customers.ledger.document')}</TableHead>
                <TableHead>{t('customers.ledger.due')}</TableHead>
                <TableHead className="text-end">{t('customers.ledger.amount')}</TableHead>
                <TableHead className="text-end">{t('customers.ledger.balance')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.ledger.map((e, n) => (
                <TableRow key={n}>
                  <TableCell>{e.entryDate}</TableCell>
                  <TableCell>
                    {t(`customers.ledger.${LEDGER_KINDS.has(e.kind) ? e.kind : 'other'}`)}{' '}
                    {e.kind === 'customer_receipt' || e.kind === 'journal_voucher' ? (
                      <a
                        href={href.accountingDocument(e.kind, e.sourceId)}
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

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span>
      <span className={LABEL_CLASS}>{label}</span> {children}
    </span>
  );
}
