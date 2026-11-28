import type { CustomerDetail, CustomerLookups, CustomerRow } from '@erp/contracts';
import {
  formatMoney,
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
} from '@erp/ui';
import { Pencil, Plus, Save, Trash2, UserCheck, UserX } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyValue } from '../catalog/data';
import { href, navigate, withQuery } from '../router';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  FIELD_LABEL,
  FormDialog,
  IconButton,
  ListPicker,
  ListToolbar,
  notify,
  Select,
  TextInput,
} from '../ui';
import { customerRefusal, phoneToCheck, useCustomerLookups } from './data';

// Customers (W1-22, D-109; POS-05, POS-07, CAT-04, PUR-01, ACC-03): the list with what each customer owes, Add and
// Edit as dialogs (as the suppliers screen, D-105), Deactivate only at a zero balance and Delete only one never used
// (owner answer 5), and a customer's page with the ledger (owner answer 7). The tier and credit terms are the owner's
// (cust.terms.edit, owner answer 2); everyone else sees them read only. Phones are shown in full here (staff only).
// W2-12 (D-127): the back office's own controls, the pilot of the new look: icon row actions, the search and filter
// in the table's toolbar, problems at their field and results in a toast.

type Status = '' | 'active' | 'inactive';

export function CustomersScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = useCustomerLookups(api);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>('active');
  const [list, setList] = useState<CustomerRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);

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
            <Button icon={Plus} onClick={() => setAdding(true)}>
              {t('customers.add')}
            </Button>
          )
        }
      />
      <CustomerDialog
        api={api}
        lookups={lookups}
        open={adding}
        onOpenChange={setAdding}
        onDone={(id, name) => {
          setAdding(false);
          notify.done(t('customers.added', { name }));
          if (id) navigate(href.customer(id));
        }}
      />
      <Panel className="overflow-hidden p-0">
        <ListToolbar
          search={{ label: t('customers.search'), value: text, onChange: setText }}
          {...(list === null ? {} : { count: t('customers.count', { count: list.length }) })}
        >
          <Select
            aria-label={t('customers.show')}
            wrapperClassName="w-36"
            value={status || 'all'}
            onValueChange={(v) => setStatus(v === 'all' ? '' : (v as Status))}
            options={[
              { value: 'active', label: t('customers.active') },
              { value: 'inactive', label: t('customers.inactive') },
              { value: 'all', label: t('customers.all') },
            ]}
          />
        </ListToolbar>
        {list === null ? (
          <p className="m-0 p-4 text-muted-foreground">{t('app.loading')}</p>
        ) : list.length === 0 ? (
          <p className="m-0 p-4 text-muted-foreground">{t('customers.empty')}</p>
        ) : (
          // Wide tables scroll sideways inside their panel, never the whole page.
          <div className="overflow-x-auto px-1.5 pb-1.5">
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
                    <TableCell className="min-w-44">
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
                      <TableCell className="w-0 text-end">
                        <CustomerActions api={api} lookups={lookups} row={c} onDone={reload} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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

/** A row's Edit, Deactivate or Reactivate, and Delete (never used only), as icons; each reads the customer first. */
function CustomerActions({
  api,
  lookups,
  row,
  onDone,
}: {
  api: Api;
  lookups: CustomerLookups;
  row: CustomerRow;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Action | null>(null);
  const [customer, setCustomer] = useState<CustomerDetail['customer'] | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async (action: Action) => {
    if (action !== 'delete') {
      const r = await api('GET', `/api/customers/${encodeURIComponent(row.id)}`);
      if (r.status !== 200) return notify.problem(customerRefusal(t, r.body));
      setCustomer((r.body as CustomerDetail).customer);
    }
    setOpen(action);
  };
  const close = () => setOpen(null);
  const deactivating = row.status === 'active';
  const statusLabel = t(deactivating ? 'customers.deactivate' : 'customers.reactivate');

  // A refusal isn't one field's: it goes to a toast and the question stays open (owner answer 6).
  const changeStatus = async () => {
    if (!customer) return;
    setBusy(true);
    const r = await api('PATCH', `/api/customers/${encodeURIComponent(row.id)}`, {
      rowVersion: customer.rowVersion,
      status: deactivating ? 'inactive' : 'active',
    });
    setBusy(false);
    if (r.status !== 200) return notify.problem(customerRefusal(t, r.body, lookups.money));
    close();
    notify.done(t(deactivating ? 'customers.deactivated' : 'customers.reactivated', { name: row.name }));
    onDone();
  };
  const remove = async () => {
    setBusy(true);
    const r = await api('DELETE', `/api/customers/${encodeURIComponent(row.id)}`);
    setBusy(false);
    if (r.status !== 200) return notify.problem(customerRefusal(t, r.body, lookups.money));
    close();
    notify.done(t('customers.deleted', { name: row.name }));
    onDone();
  };

  return (
    <span className="inline-flex justify-end gap-0.5">
      <IconButton
        icon={Pencil}
        label={`${t('customers.edit')} ${row.name}`}
        onClick={() => void start('edit')}
      />
      <IconButton
        icon={deactivating ? UserX : UserCheck}
        label={`${statusLabel} ${row.name}`}
        onClick={() => void start('status')}
      />
      {row.deletable && (
        <IconButton
          icon={Trash2}
          tone="danger"
          label={`${t('customers.delete')} ${row.name}`}
          onClick={() => void start('delete')}
        />
      )}
      {customer && (
        <CustomerDialog
          key={customer.rowVersion}
          api={api}
          lookups={lookups}
          customer={customer}
          open={open === 'edit'}
          onOpenChange={(o) => !o && close()}
          onDone={(_, name) => {
            close();
            notify.done(t('customers.saved', { name }));
            onDone();
          }}
        />
      )}
      <ConfirmDialog
        open={open === 'status'}
        onOpenChange={(o) => !o && close()}
        title={t(deactivating ? 'customers.deactivateTitle' : 'customers.reactivateTitle', {
          name: row.name,
        })}
        actionLabel={statusLabel}
        actionIcon={deactivating ? UserX : UserCheck}
        cancelLabel={t('customers.cancel')}
        busy={busy}
        onConfirm={() => void changeStatus()}
      >
        {t(deactivating ? 'customers.deactivateText' : 'customers.reactivateText')}
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={t('customers.deleteTitle', { name: row.name })}
        actionLabel={t('customers.delete')}
        actionIcon={Trash2}
        tone="danger"
        cancelLabel={t('customers.cancel')}
        busy={busy}
        onConfirm={() => void remove()}
      >
        {t('customers.deleteText')}
      </ConfirmDialog>
    </span>
  );
}

type Form = {
  source: 'new' | 'supplier';
  supplierId: string;
  code: string;
  name: string;
  phones: string;
  city: string;
  contactPerson: string;
  address: string;
  notes: string;
  tierId: string;
  creditAllowed: boolean;
  noLimit: boolean;
  limit: string;
  cap: string;
  termsDays: string;
};
type Problems = Partial<Record<keyof Form, string>>;

/** The refusals that name a field show at it (owner answer 6); the rest go to a toast. */
const REFUSAL_FIELD: Record<string, keyof Form> = {
  code_taken: 'code',
  phone_invalid: 'phones',
  limit_required: 'limit',
  already_customer: 'supplierId',
};

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
  /** The customer's id (null when it can't be told) and name, once saved. */
  onDone: (id: string | null, name: string) => void;
}) {
  const { t } = useTranslation();
  const minor = lookups.money.minorUnits;
  const defaultTier = lookups.tiers.find((x) => x.isDefault)?.id ?? lookups.tiers[0]?.id ?? '';
  const blank = (): Form => ({
    source: 'new',
    supplierId: '',
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
  const [problems, setProblems] = useState<Problems>({});
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ check: string; row: CustomerRow | null } | null>(null);
  // Changing a field clears its problem; the others stay until the next save.
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setProblems((p) => (p[k] ? { ...p, [k]: undefined } : p));
  };
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

  /** The terms to send, and every problem with them at once (owner answer 6). */
  const terms = (wrong: Problems) => {
    const days = f.termsDays.trim() === '' ? null : Number(f.termsDays);
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 365))
      wrong.termsDays = t('customers.problems.terms');
    const cap = moneyValue(f.cap, minor);
    if (f.creditAllowed && (typeof cap !== 'number' || cap < 0)) wrong.cap = t('customers.problems.amount');
    let limit: number | null = null;
    if (f.creditAllowed && !f.noLimit) {
      const v = moneyValue(f.limit, minor);
      if (v === null) wrong.limit = t('customers.problems.limit');
      else if (v === undefined || v < 0) wrong.limit = t('customers.problems.amount');
      else limit = v;
    } else if (!f.creditAllowed && !f.noLimit) {
      // Credit off keeps the limit (owner answer 5: stopping a debtor), so turning it back on finds it.
      const v = moneyValue(f.limit, minor);
      limit = typeof v === 'number' && v >= 0 ? v : null;
    }
    return {
      tierId: f.tierId,
      creditAllowed: f.creditAllowed,
      creditLimit: limit,
      noLimit: f.creditAllowed && f.noLimit,
      offlineDailyCap: typeof cap === 'number' ? cap : lookups.defaultOfflineDailyCap,
      termsDays: days,
    };
  };

  const submit = async () => {
    const wrong: Problems = {};
    let body: Record<string, unknown>;
    if (fromSupplier) {
      if (f.supplierId === '') wrong.supplierId = t('customers.problems.supplier');
      body = { partyId: f.supplierId };
    } else {
      if (f.name.trim() === '') wrong.name = t('customers.problems.name');
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
    }
    if (canTerms) body['terms'] = terms(wrong);
    setProblems(wrong);
    if (Object.values(wrong).some(Boolean)) return;
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
      const name = fromSupplier
        ? (lookups.suppliers.find((s) => s.id === f.supplierId)?.name ?? '')
        : f.name.trim();
      setF(blank());
      setProblems({});
      return onDone(r.status === 201 ? (r.body as { id: string }).id : (customer?.id ?? null), name);
    }
    const field = REFUSAL_FIELD[(r.body as { error?: string } | null)?.error ?? ''];
    const text = customerRefusal(t, r.body, lookups.money);
    if (field) setProblems({ [field]: text });
    else notify.problem(text);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setProblems({});
        onOpenChange(o);
      }}
      title={customer ? t('customers.details') : t('customers.add')}
      actionLabel={customer ? t('customers.save') : t('customers.create')}
      actionIcon={customer ? Save : Plus}
      cancelLabel={t('customers.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
      size="lg"
      errors={problems}
    >
      {!customer && lookups.suppliers.length > 0 && (
        <Select
          label={t('customers.source.label')}
          value={f.source}
          onValueChange={(v) => set('source', v as Form['source'])}
          options={[
            { value: 'new', label: t('customers.source.new') },
            { value: 'supplier', label: t('customers.source.supplier') },
          ]}
        />
      )}
      {fromSupplier ? (
        // A list that keeps growing gets a search (owner answer 3, W2-13).
        <ListPicker
          label={t('customers.source.pick')}
          options={lookups.suppliers}
          value={f.supplierId}
          onChange={(id) => set('supplierId', id)}
          error={problems.supplierId}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {!customer && (
            <TextInput
              label={t('customers.fields.code')}
              hint={t('customers.fields.codeHint')}
              error={problems.code}
              value={f.code}
              onChange={(e) => set('code', e.target.value)}
            />
          )}
          <TextInput
            label={t('customers.fields.name')}
            error={problems.name}
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <TextInput
            label={t('customers.fields.phones')}
            hint={t('customers.fields.phonesHint')}
            error={problems.phones}
            inputMode="tel"
            value={f.phones}
            onChange={(e) => set('phones', e.target.value)}
          />
          <TextInput
            label={t('customers.fields.city')}
            value={f.city}
            onChange={(e) => set('city', e.target.value)}
          />
          <TextInput
            label={t('customers.fields.contact')}
            value={f.contactPerson}
            onChange={(e) => set('contactPerson', e.target.value)}
          />
          <TextInput
            label={t('customers.fields.address')}
            value={f.address}
            onChange={(e) => set('address', e.target.value)}
          />
          <TextInput
            wrapperClassName="sm:col-span-2"
            label={t('customers.fields.notes')}
            value={f.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>
      )}
      {twin && (
        <p role="status" className="m-0 text-[13px] font-medium text-warn">
          {t('customers.phoneUsed', { code: twin.code, name: twin.name })}
        </p>
      )}
      <fieldset
        className="m-0 grid grid-cols-1 gap-3.5 border-0 border-t border-line p-0 pt-4 sm:grid-cols-2"
        disabled={!canTerms}
      >
        <legend className="float-start mb-1 w-full text-sm font-semibold sm:col-span-2">
          {t('customers.fields.credit')}
        </legend>
        {!canTerms && (
          <p className="m-0 text-sm text-muted-foreground sm:col-span-2">
            {t(customer ? 'customers.termsLockedEdit' : 'customers.termsLocked')}
          </p>
        )}
        <Select
          label={t('customers.fields.tier')}
          disabled={!canTerms}
          value={f.tierId}
          onValueChange={(v) => set('tierId', v)}
          options={lookups.tiers.map((x) => ({ value: x.id, label: x.name }))}
        />
        <TextInput
          label={t('customers.fields.terms')}
          error={problems.termsDays}
          inputMode="numeric"
          value={f.termsDays}
          onChange={(e) => set('termsDays', e.target.value)}
        />
        <Checkbox
          className="sm:col-span-2"
          label={t('customers.fields.creditAllowed')}
          disabled={!canTerms}
          checked={f.creditAllowed}
          onCheckedChange={(v) => set('creditAllowed', v)}
        />
        {f.creditAllowed && (
          <>
            <TextInput
              label={t('customers.fields.limit')}
              error={problems.limit}
              inputMode="decimal"
              disabled={f.noLimit || !canTerms}
              value={f.noLimit ? '' : f.limit}
              onChange={(e) => set('limit', e.target.value)}
            />
            <Checkbox
              className="self-end pb-2"
              label={t('customers.fields.noLimit')}
              disabled={!canTerms}
              checked={f.noLimit}
              onCheckedChange={(v) => set('noLimit', v)}
            />
            <TextInput
              label={t('customers.fields.cap')}
              hint={t('customers.fields.capHint')}
              error={problems.cap}
              inputMode="decimal"
              value={f.cap}
              onChange={(e) => set('cap', e.target.value)}
            />
          </>
        )}
      </fieldset>
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

/** `reports`: whether this person may open the reports (reports.view): the ledger then links to the full one (W2-04). */
export function CustomerScreen({ api, id, reports = false }: { api: Api; id: string; reports?: boolean }) {
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
            <Button variant="outline" icon={Pencil} onClick={() => setEditing(true)}>
              {t('customers.edit')}
            </Button>
          )
        }
      />
      <CustomerDialog
        key={`edit-${c.rowVersion}-${c.accountVersion}`}
        api={api}
        lookups={lookups}
        customer={c}
        open={editing}
        onOpenChange={setEditing}
        onDone={(_, name) => {
          setEditing(false);
          notify.done(t('customers.saved', { name }));
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
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-2 pt-3">
          <h2 className="m-0 font-display text-lg font-semibold">{t('customers.ledger.title')}</h2>
          {reports && (
            <a href={withQuery(href.partnerLedger, { role: 'customer', partyId: c.id, statement: '1' })}>
              {t('customers.ledger.report')}
            </a>
          )}
        </div>
        {detail.ledger.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('customers.ledger.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
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
          </div>
        )}
      </Panel>
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span>
      <span className={FIELD_LABEL}>{label}</span> {children}
    </span>
  );
}
