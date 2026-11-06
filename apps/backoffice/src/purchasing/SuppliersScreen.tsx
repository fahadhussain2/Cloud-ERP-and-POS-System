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
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyValue } from '../catalog/data';
import { href, navigate } from '../router';
import { purchasingRefusal, today, usePurchasingLookups } from './data';
import { PurchasingNotice } from './PurchasingNotice';

// Suppliers (W1-16, PUR-01, PUR-09): the list with what the shop owes each, a supplier's details (terms, the label
// abbreviation for W1-17), the ledger with its running balance, and a payment by bank (owner and accountant, owner
// answer 2). Cash is paid at the desk (owner answer 1).

export function SuppliersScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const lookups = usePurchasingLookups(api);
  const [text, setText] = useState('');
  const [list, setList] = useState<SupplierRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const searchId = useId();

  const load = useCallback(async () => {
    const r = await api('GET', `/api/purchasing/suppliers?q=${encodeURIComponent(text)}`);
    setList(r.status === 200 ? (r.body as { suppliers: SupplierRow[] }).suppliers : []);
  }, [api, text]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  return (
    <>
      <PageHeader
        title={t('purchasing.suppliers.title')}
        help={t('purchasing.suppliers.help')}
        actions={
          lookups.can.receive && (
            <Button size="lg" onClick={() => setAdding(true)}>
              {t('purchasing.suppliers.add')}
            </Button>
          )
        }
      />
      <PurchasingNotice lookups={lookups} />
      {adding && (
        <SupplierForm
          api={api}
          onDone={(id) => {
            setAdding(false);
            if (id) navigate(href.supplier(id));
          }}
        />
      )}
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}

/** A new supplier, or a supplier's details. */
function SupplierForm({
  api,
  supplier,
  onDone,
}: {
  api: Api;
  supplier?: SupplierDetail['supplier'];
  onDone: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    code: supplier?.code ?? '',
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phones: supplier?.phones.join(', ') ?? '',
    address: supplier?.address ?? '',
    termsDays: supplier?.termsDays === null || supplier === undefined ? '' : String(supplier.termsDays),
    labelAbbr: supplier?.labelAbbr ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
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
    const r = supplier
      ? await api('PATCH', `/api/purchasing/suppliers/${encodeURIComponent(supplier.id)}`, {
          ...body,
          rowVersion: supplier.rowVersion,
        })
      : await api('POST', '/api/purchasing/suppliers', { ...body, code: f.code });
    if (r.status === 200) return onDone(supplier?.id ?? null);
    if (r.status === 201) return onDone((r.body as { id: string }).id);
    setError(purchasingRefusal(t, (k) => t(k) !== k, r.body));
  };

  return (
    <Panel
      role="region"
      aria-label={supplier ? t('purchasing.suppliers.details') : t('purchasing.suppliers.add')}
    >
      <form className="grid gap-3.5 p-3.5 md:grid-cols-3" onSubmit={(e) => void submit(e)}>
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
        {error && (
          <p role="alert" className="m-0 text-sm text-destructive md:col-span-3">
            {error}
          </p>
        )}
        <div className="flex gap-2 md:col-span-3">
          <Button type="submit">
            {supplier ? t('purchasing.suppliers.save') : t('purchasing.suppliers.create')}
          </Button>
          <Button type="button" variant="outline" onClick={() => onDone(null)}>
            {t('purchasing.cancel')}
          </Button>
        </div>
      </form>
    </Panel>
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
      {editing && (
        <SupplierForm
          api={api}
          supplier={s}
          onDone={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
      {paying && (
        <PayByBank
          api={api}
          lookups={lookups}
          supplierId={s.id}
          onDone={(number) => {
            setPaying(false);
            if (number) setMessage(t('purchasing.pay.done', { number }));
            void load();
          }}
        />
      )}
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

function PayByBank({
  api,
  lookups,
  supplierId,
  onDone,
}: {
  api: Api;
  lookups: PurchasingLookups;
  supplierId: string;
  onDone: (number: string | null) => void;
}) {
  const { t } = useTranslation();
  const [bank, setBank] = useState(lookups.bankAccounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bankId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = moneyValue(amount, lookups.money.minorUnits);
    if (typeof value !== 'number' || value <= 0) return setError(t('purchasing.problems.amount'));
    const r = await api('POST', '/api/purchasing/payments', {
      supplierId,
      bankAccountId: bank,
      amount: value,
      paidOn,
      reference,
    });
    if (r.status === 201) return onDone((r.body as { number: string }).number);
    setError(purchasingRefusal(t, (k) => t(k) !== k, r.body));
  };
  return (
    <Panel role="region" aria-label={t('purchasing.pay.title')}>
      <form className="grid gap-3.5 p-3.5 md:grid-cols-4" onSubmit={(e) => void submit(e)}>
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
          value={paidOn}
          onChange={(e) => setPaidOn(e.target.value)}
        />
        <TextField
          label={t('purchasing.pay.reference')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        {error && (
          <p role="alert" className="m-0 text-sm text-destructive md:col-span-4">
            {error}
          </p>
        )}
        <div className="flex gap-2 md:col-span-4">
          <Button type="submit">{t('purchasing.pay.confirm')}</Button>
          <Button type="button" variant="outline" onClick={() => onDone(null)}>
            {t('purchasing.cancel')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
