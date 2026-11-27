import type { PurchasingLookups, SupplierDetail, SupplierRow } from '@erp/contracts';
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
import { Banknote, Pencil, Plus, Save, Trash2, UserCheck, UserX } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyValue } from '../catalog/data';
import { href, navigate, withQuery } from '../router';
import {
  Button,
  ConfirmDialog,
  FIELD_LABEL,
  FormDialog,
  IconButton,
  ListToolbar,
  notify,
  Select,
  TextInput,
} from '../ui';
import { dateProblem, purchasingRefusal, usePurchasingLookups } from './data';

// Suppliers (W1-16, PUR-01, PUR-09): the list with what the shop owes each, a supplier's details (terms, the label
// abbreviation for W1-17), the ledger with its running balance, and a payment by bank (owner and accountant, owner
// answer 2). Cash is paid at the desk (owner answer 1). Add, Edit, Pay by bank, Deactivate and Delete open as dialogs
// (owner review, 2026-11-07); Delete only for a supplier never used, Deactivate only when nothing is owed.
// W2-14 (D-127): the back office's own controls: icon row actions, the search in the table's toolbar, problems at
// their field and results in a toast.

export function SuppliersScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [text, setText] = useState('');
  const [list, setList] = useState<SupplierRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);

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
            <Button icon={Plus} onClick={() => setAdding(true)}>
              {t('purchasing.suppliers.add')}
            </Button>
          )
        }
      />
      <SupplierDialog
        api={api}
        open={adding}
        onOpenChange={setAdding}
        onDone={(id, name) => {
          setAdding(false);
          notify.done(t('purchasing.suppliers.added', { name }));
          if (id) navigate(href.supplier(id));
        }}
      />
      <Panel className="overflow-hidden p-0">
        <ListToolbar
          search={{ label: t('purchasing.suppliers.search'), value: text, onChange: setText }}
          {...(list === null ? {} : { count: t('purchasing.suppliers.count', { count: list.length }) })}
        />
        {list === null ? (
          <p className="m-0 p-4 text-muted-foreground">{t('app.loading')}</p>
        ) : list.length === 0 ? (
          <p className="m-0 p-4 text-muted-foreground">{t('purchasing.suppliers.empty')}</p>
        ) : (
          <div className="overflow-x-auto px-1.5 pb-1.5">
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
                    <TableCell className="min-w-44">
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
                      <TableCell className="w-0 text-end">
                        <SupplierActions api={api} row={s} money={lookups.money} onDone={reload} />
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

type Action = 'edit' | 'status' | 'delete';

/**
 * A row's Edit, Deactivate or Reactivate, and Delete (a supplier never used only), as icons. Each opens a dialog; Edit
 * and the status change read the supplier first, for its details and row version. A refusal is a toast and the
 * question stays open (owner answer 6).
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
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Action | null>(null);
  const [supplier, setSupplier] = useState<SupplierDetail['supplier'] | null>(null);
  const [busy, setBusy] = useState(false);
  const exists = (k: string) => t(k) !== k;

  const start = async (action: Action) => {
    if (action !== 'delete') {
      const r = await api('GET', `/api/purchasing/suppliers/${encodeURIComponent(row.id)}`);
      if (r.status !== 200) return notify.problem(purchasingRefusal(t, exists, r.body));
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
    if (r.status !== 200) return notify.problem(purchasingRefusal(t, exists, r.body, money));
    close();
    notify.done(
      t(deactivating ? 'purchasing.suppliers.deactivated' : 'purchasing.suppliers.reactivated', {
        name: row.name,
      }),
    );
    onDone();
  };
  const remove = async () => {
    setBusy(true);
    const r = await api('DELETE', `/api/purchasing/suppliers/${encodeURIComponent(row.id)}`);
    setBusy(false);
    if (r.status !== 200) return notify.problem(purchasingRefusal(t, exists, r.body, money));
    close();
    notify.done(t('purchasing.suppliers.deleted', { name: row.name }));
    onDone();
  };

  return (
    <span className="inline-flex justify-end gap-0.5">
      <IconButton
        icon={Pencil}
        label={`${t('purchasing.suppliers.edit')} ${row.name}`}
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
          label={`${t('purchasing.suppliers.delete')} ${row.name}`}
          onClick={() => void start('delete')}
        />
      )}
      {supplier && (
        <SupplierDialog
          api={api}
          supplier={supplier}
          open={open === 'edit'}
          onOpenChange={(o) => !o && close()}
          onDone={(_, name) => {
            close();
            notify.done(t('purchasing.suppliers.saved', { name }));
            onDone();
          }}
        />
      )}
      <ConfirmDialog
        open={open === 'status'}
        onOpenChange={(o) => !o && close()}
        title={t(
          deactivating ? 'purchasing.suppliers.deactivateTitle' : 'purchasing.suppliers.reactivateTitle',
          { name: row.name },
        )}
        actionLabel={statusLabel}
        actionIcon={deactivating ? UserX : UserCheck}
        cancelLabel={t('purchasing.cancel')}
        busy={busy}
        onConfirm={() => void changeStatus()}
      >
        {t(deactivating ? 'purchasing.suppliers.deactivateText' : 'purchasing.suppliers.reactivateText')}
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'delete'}
        onOpenChange={(o) => !o && close()}
        title={t('purchasing.suppliers.deleteTitle', { name: row.name })}
        actionLabel={t('purchasing.suppliers.delete')}
        actionIcon={Trash2}
        tone="danger"
        cancelLabel={t('purchasing.cancel')}
        busy={busy}
        onConfirm={() => void remove()}
      >
        {t('purchasing.suppliers.deleteText')}
      </ConfirmDialog>
    </span>
  );
}

type SupplierForm = {
  code: string;
  name: string;
  contactPerson: string;
  phones: string;
  address: string;
  termsDays: string;
  labelAbbr: string;
};

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
  /** The supplier's id (null when it can't be told) and name, once saved. */
  onDone: (id: string | null, name: string) => void;
}) {
  const { t } = useTranslation();
  const blank = (): SupplierForm => ({
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phones: supplier?.phones.join(', ') ?? '',
    address: supplier?.address ?? '',
    termsDays: supplier?.termsDays === null || supplier === undefined ? '' : String(supplier.termsDays),
    labelAbbr: supplier?.labelAbbr ?? '',
  });
  const [f, setF] = useState(blank);
  const [problems, setProblems] = useState<Partial<Record<keyof SupplierForm, string>>>({});
  const [busy, setBusy] = useState(false);
  // Changing a field clears its problem; the others stay until the next save (owner answer 6).
  const set = (k: keyof SupplierForm, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setProblems((p) => (p[k] ? { ...p, [k]: undefined } : p));
  };

  const submit = async () => {
    const wrong: typeof problems = {};
    const terms = f.termsDays.trim() === '' ? null : Number(f.termsDays);
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365))
      wrong.termsDays = t('purchasing.problems.terms');
    if (f.name.trim() === '') wrong.name = t('purchasing.problems.name');
    setProblems(wrong);
    if (Object.values(wrong).some(Boolean)) return;
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
      const name = f.name.trim();
      setF(blank());
      setProblems({});
      return onDone(r.status === 201 ? (r.body as { id: string }).id : (supplier?.id ?? null), name);
    }
    const text = purchasingRefusal(t, (k) => t(k) !== k, r.body);
    // A taken code shows at the code field; the rest in a toast.
    if ((r.body as { error?: string } | null)?.error === 'code_taken') setProblems({ code: text });
    else notify.problem(text);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setProblems({});
        onOpenChange(o);
      }}
      title={supplier ? t('purchasing.suppliers.details') : t('purchasing.suppliers.add')}
      actionLabel={supplier ? t('purchasing.suppliers.save') : t('purchasing.suppliers.create')}
      actionIcon={supplier ? Save : Plus}
      cancelLabel={t('purchasing.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
      size="lg"
      errors={problems}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {!supplier && (
          <TextInput
            label={t('purchasing.fields.code')}
            error={problems.code}
            value={f.code}
            onChange={(e) => set('code', e.target.value)}
          />
        )}
        <TextInput
          label={t('purchasing.fields.name')}
          error={problems.name}
          value={f.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <TextInput
          label={t('purchasing.fields.contact')}
          value={f.contactPerson}
          onChange={(e) => set('contactPerson', e.target.value)}
        />
        <TextInput
          label={t('purchasing.fields.phones')}
          hint={t('purchasing.fields.phonesHint')}
          value={f.phones}
          onChange={(e) => set('phones', e.target.value)}
        />
        <TextInput
          label={t('purchasing.fields.address')}
          value={f.address}
          onChange={(e) => set('address', e.target.value)}
        />
        <TextInput
          label={t('purchasing.fields.terms')}
          error={problems.termsDays}
          inputMode="numeric"
          value={f.termsDays}
          onChange={(e) => set('termsDays', e.target.value)}
        />
        <TextInput
          label={t('purchasing.fields.labelAbbr')}
          hint={t('purchasing.fields.labelAbbrHint')}
          value={f.labelAbbr}
          onChange={(e) => set('labelAbbr', e.target.value)}
        />
      </div>
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

/** `reports`: whether this person may open the supplier ledger report (reports.view and cost.view, W2-04). */
export function SupplierScreen({ api, id, reports = false }: { api: Api; id: string; reports?: boolean }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [detail, setDetail] = useState<SupplierDetail | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
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
              <Button variant="outline" icon={Pencil} onClick={() => setEditing(true)}>
                {t('purchasing.suppliers.edit')}
              </Button>
            )}
            {lookups.can.payByBank && (
              <Button icon={Banknote} onClick={() => setPaying(true)}>
                {t('purchasing.pay.action')}
              </Button>
            )}
          </span>
        }
      />
      <SupplierDialog
        key={`edit-${s.rowVersion}`}
        api={api}
        supplier={s}
        open={editing}
        onOpenChange={setEditing}
        onDone={(_, name) => {
          setEditing(false);
          notify.done(t('purchasing.suppliers.saved', { name }));
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
          notify.done(t('purchasing.pay.done', { number }));
          load();
        }}
      />
      <Panel className="flex flex-wrap gap-x-8 gap-y-2 p-3.5 text-sm">
        <Fact label={t('purchasing.fields.code')}>
          <span className="font-mono">{s.code}</span>
        </Fact>
        <Fact label={t('purchasing.fields.terms')}>
          {s.termsDays === null ? '—' : t('purchasing.suppliers.days', { count: s.termsDays })}
        </Fact>
        <Fact label={t('purchasing.fields.labelAbbr')}>{s.labelAbbr ?? '—'}</Fact>
        <Fact label={t('purchasing.fields.phones')}>{s.phones.join(', ') || '—'}</Fact>
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-2 pt-3">
          <h2 className="m-0 font-display text-lg font-semibold">{t('purchasing.ledger.title')}</h2>
          {reports && (
            <a href={withQuery(href.partnerLedger, { role: 'supplier', partyId: s.id, statement: '1' })}>
              {t('purchasing.ledger.report')}
            </a>
          )}
        </div>
        {detail.ledger.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t('purchasing.ledger.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
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
  const [problems, setProblems] = useState<{ amount?: string }>({});
  const [busy, setBusy] = useState(false);
  // A payment dated after the shop's business date (W2-05) or on or before the lock date (D-108) can't post: the date
  // says why before it is sent.
  const locked = dateProblem(t, paidOn, lookups);
  const submit = async () => {
    const value = moneyValue(amount, lookups.money.minorUnits);
    const wrong = typeof value !== 'number' || value <= 0 ? { amount: t('purchasing.problems.amount') } : {};
    setProblems(wrong);
    if (locked || typeof value !== 'number' || value <= 0) return;
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
      setProblems({});
      return onDone((r.body as { number: string }).number);
    }
    notify.problem(purchasingRefusal(t, (k) => t(k) !== k, r.body));
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setProblems({});
        onOpenChange(o);
      }}
      title={t('purchasing.pay.title')}
      actionLabel={t('purchasing.pay.confirm')}
      actionIcon={Banknote}
      cancelLabel={t('purchasing.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
      errors={{ ...problems, paidOn: locked ?? undefined }}
    >
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Select
          label={t('purchasing.pay.bank')}
          value={bank}
          onValueChange={setBank}
          options={lookups.bankAccounts.map((b) => ({ value: b.id, label: b.name }))}
        />
        <TextInput
          label={t('purchasing.pay.amount')}
          error={problems.amount}
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            setProblems({});
          }}
        />
        <TextInput
          label={t('purchasing.pay.date')}
          type="date"
          error={locked}
          max={lookups.today}
          value={paidOn}
          onChange={(e) => setPaidOn(e.target.value)}
        />
        <TextInput
          label={t('purchasing.pay.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}
