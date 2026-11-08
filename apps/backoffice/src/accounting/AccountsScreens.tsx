import type { AccountBalanceRow, AccountingLookups, LedgerView } from '@erp/contracts';
import {
  Button,
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
  TextField,
} from '@erp/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { href } from '../router';
import { FormDialog } from '../staff/dialogs';
import { accountingRefusal, AccountSelect, ErrorText, useAccountingLookups } from './data';

// The chart with each account's balance at a date, an account's ledger with its running balance (part of ACC-07, owner
// answer 3 to W1-19), and the accountant's new accounts and expense categories (owner answer 4). Banks, wallets and
// roles stay a setup job.

/** Where a ledger line's document opens in the back office, when it is one of its own. */
function sourceHref(type: string, id: string): string | null {
  if (['customer_receipt', 'expense', 'fund_transfer', 'supplier_payment', 'journal_voucher'].includes(type))
    return href.accountingDocument(type, id);
  if (type === 'goods_receipt') return href.receipt(id);
  if (type === 'purchase_return') return href.purchaseReturn(id);
  if (type === 'stock_transfer' || type === 'stock_transfer_receipt') return href.transfer(id);
  if (type === 'stock_adjustment') return href.adjustment(id);
  return null;
}

export function AccountsScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const lookups = useAccountingLookups(api, version);
  const [at, setAt] = useState('');
  const [rows, setRows] = useState<AccountBalanceRow[] | null>(null);
  const [adding, setAdding] = useState<AccountBalanceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api('GET', `/api/accounting/accounts${at ? `?at=${at}` : ''}`).then(
      (r) => live && setRows(r.status === 200 ? (r.body as AccountBalanceRow[]) : []),
    );
    return () => {
      live = false;
    };
  }, [api, at, version]);
  if (lookups === null || rows === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const depth = (r: AccountBalanceRow): number => {
    const parent = rows.find((p) => p.id === r.parentId);
    return parent ? depth(parent) + 1 : 0;
  };
  // Parents before their children, each level in code order.
  const ordered: AccountBalanceRow[] = [];
  const walk = (parent: string | null) => {
    for (const r of rows.filter((x) => x.parentId === parent).sort((a, b) => a.code.localeCompare(b.code))) {
      ordered.push(r);
      walk(r.id);
    }
  };
  walk(null);
  const deactivate = async (r: AccountBalanceRow) => {
    const res = await api('PATCH', `/api/accounting/accounts/${encodeURIComponent(r.id)}`, {
      active: !r.active,
    });
    if (res.status === 200) {
      setError(null);
      return setVersion((v) => v + 1);
    }
    setError(accountingRefusal(t, res.body));
  };
  return (
    <>
      <PageHeader title={t('accounting.accounts.title')} help={t('accounting.accounts.help')} />
      <Panel className="flex flex-wrap items-end gap-3 p-3.5">
        <TextField
          label={t('accounting.accounts.at')}
          type="date"
          value={at || lookups.today}
          onChange={(e) => setAt(e.target.value)}
          wrapperClassName="w-48"
        />
      </Panel>
      <ErrorText text={error} />
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('accounting.accounts.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('accounting.fields.account')}</TableHead>
              <TableHead className="text-end">{t('accounting.accounts.balance')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((r) => (
              <TableRow key={r.id}>
                <TableCell style={{ paddingInlineStart: `${depth(r) * 1.25 + 0.5}rem` }}>
                  {r.postable ? (
                    <a href={href.ledger(r.id)} className="underline-offset-4 hover:underline">
                      <span className="font-mono">{r.code}</span> {r.name}
                    </a>
                  ) : (
                    <span className="font-semibold">
                      <span className="font-mono">{r.code}</span> {r.name}
                    </span>
                  )}{' '}
                  {!r.active && <StatusChip tone="neutral">{t('accounting.accounts.inactive')}</StatusChip>}
                </TableCell>
                <TableCell className={`text-end tabular-nums ${r.postable ? '' : 'font-semibold'}`}>
                  {formatMoney(r.balance, lookups.money)}
                </TableCell>
                <TableCell className="text-end">
                  {lookups.can.chart && !r.postable && (
                    <Button size="sm" variant="outline" onClick={() => setAdding(r)}>
                      {t('accounting.accounts.add')}
                    </Button>
                  )}
                  {lookups.can.chart && r.postable && r.role === null && (
                    <Button size="sm" variant="ghost" onClick={() => void deactivate(r)}>
                      {r.active ? t('accounting.accounts.deactivate') : t('accounting.accounts.activate')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      {adding && (
        <NewAccountDialog
          api={api}
          parent={adding}
          rows={rows}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}

/** The next free code under a heading: one more than its last child's, else the heading's own code + 10. */
function nextCode(parent: AccountBalanceRow, rows: AccountBalanceRow[]): string {
  const taken = new Set(rows.map((r) => r.code));
  const children = rows.filter((r) => r.parentId === parent.id).map((r) => Number(r.code));
  let n = children.length > 0 ? Math.max(...children) + 10 : Number(parent.code) + 10;
  while (taken.has(String(n))) n += 1;
  return String(n);
}

function NewAccountDialog({
  api,
  parent,
  rows,
  onClose,
  onDone,
}: {
  api: Api;
  parent: AccountBalanceRow;
  rows: AccountBalanceRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(nextCode(parent, rows));
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await api('POST', '/api/accounting/accounts', { parentId: parent.id, code, name });
    setBusy(false);
    if (r.status === 201) return onDone();
    setError(accountingRefusal(t, r.body));
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('accounting.accounts.addTitle', { parent: `${parent.code} ${parent.name}` })}
      actionLabel={t('accounting.accounts.add')}
      cancelLabel={t('accounting.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-3.5 sm:grid-cols-[8rem_1fr]">
        <TextField
          label={t('accounting.accounts.code')}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <TextField
          label={t('accounting.accounts.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <ErrorText text={error} />
    </FormDialog>
  );
}

export function LedgerScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = useAccountingLookups(api);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [ledger, setLedger] = useState<LedgerView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    void api('GET', `/api/accounting/accounts/${encodeURIComponent(id)}/ledger?${q.toString()}`).then(
      (r) => live && setLedger(r.status === 200 ? (r.body as LedgerView) : null),
    );
    return () => {
      live = false;
    };
  }, [api, id, from, to]);
  if (lookups === null || ledger === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (ledger === null) return <PageHeader title={t('accounting.document.notFound')} />;
  const m = lookups.money;
  return (
    <>
      <PageHeader
        eyebrow={
          <a href={href.accounts} className="underline-offset-4 hover:underline">
            {t('accounting.accounts.title')}
          </a>
        }
        title={`${ledger.account.code} ${ledger.account.name}`}
        help={t('accounting.ledger.help')}
      />
      <Panel className="flex flex-wrap items-end gap-3 p-3.5">
        <TextField
          label={t('accounting.ledger.from')}
          type="date"
          value={from || ledger.from}
          onChange={(e) => setFrom(e.target.value)}
          wrapperClassName="w-48"
        />
        <TextField
          label={t('accounting.ledger.to')}
          type="date"
          value={to || ledger.to}
          onChange={(e) => setTo(e.target.value)}
          wrapperClassName="w-48"
        />
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('accounting.ledger.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('accounting.fields.date')}</TableHead>
              <TableHead>{t('accounting.ledger.journal')}</TableHead>
              <TableHead>{t('accounting.ledger.memo')}</TableHead>
              <TableHead>{t('accounting.fields.party')}</TableHead>
              <TableHead className="text-end">{t('accounting.fields.debit')}</TableHead>
              <TableHead className="text-end">{t('accounting.fields.credit')}</TableHead>
              <TableHead className="text-end">{t('accounting.accounts.balance')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell colSpan={6}>{t('accounting.ledger.opening')}</TableCell>
              <TableCell className="text-end tabular-nums">{formatMoney(ledger.opening, m)}</TableCell>
            </TableRow>
            {ledger.lines.map((l, i) => {
              const link = sourceHref(l.sourceType, l.sourceId);
              return (
                <TableRow key={i}>
                  <TableCell>{l.date}</TableCell>
                  <TableCell>
                    {link ? (
                      <a href={link} className="font-mono underline-offset-4 hover:underline">
                        {l.journalNumber}
                      </a>
                    ) : (
                      <span className="font-mono">{l.journalNumber}</span>
                    )}
                  </TableCell>
                  <TableCell>{l.memo ?? ''}</TableCell>
                  <TableCell>{l.partyName ?? ''}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {l.debit ? formatMoney(l.debit, m) : ''}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {l.credit ? formatMoney(l.credit, m) : ''}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{formatMoney(l.balance, m)}</TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell colSpan={6} className="font-semibold">
                {t('accounting.ledger.closing')}
              </TableCell>
              <TableCell className="text-end font-semibold tabular-nums">
                {formatMoney(ledger.closing, m)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        {ledger.truncated && <p className="m-0 px-2 text-sm text-warn">{t('accounting.ledger.truncated')}</p>}
      </Panel>
    </>
  );
}

export function ExpenseCategoriesScreen({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const lookups = useAccountingLookups(api, version);
  const [editing, setEditing] = useState<AccountingLookups['categories'][number] | 'new' | null>(null);
  if (lookups === null) return <p className="text-muted-foreground">{t('app.loading')}</p>;
  const accountName = (id: string) => {
    const a = lookups.accounts.find((x) => x.id === id);
    return a ? `${a.code} ${a.name}` : '—';
  };
  return (
    <>
      <PageHeader
        title={t('accounting.categories.title')}
        help={t('accounting.categories.help')}
        actions={
          lookups.can.chart && (
            <Button onClick={() => setEditing('new')}>{t('accounting.categories.new')}</Button>
          )
        }
      />
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('accounting.categories.title')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('accounting.accounts.code')}</TableHead>
              <TableHead>{t('accounting.accounts.name')}</TableHead>
              <TableHead>{t('accounting.fields.account')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lookups.categories.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono">{c.code}</TableCell>
                <TableCell>
                  {c.name}{' '}
                  {!c.active && <StatusChip tone="neutral">{t('accounting.accounts.inactive')}</StatusChip>}
                </TableCell>
                <TableCell>{accountName(c.accountId)}</TableCell>
                <TableCell className="text-end">
                  {lookups.can.chart && (
                    <Button size="sm" variant="outline" onClick={() => setEditing(c)}>
                      {t('accounting.categories.edit')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
      {editing !== null && (
        <CategoryDialog
          api={api}
          lookups={lookups}
          category={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}

function CategoryDialog({
  api,
  lookups,
  category,
  onClose,
  onDone,
}: {
  api: Api;
  lookups: AccountingLookups;
  category: AccountingLookups['categories'][number] | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const expenseAccounts = lookups.accounts.filter((a) => a.type === 'expense' && a.postable && a.active);
  const [code, setCode] = useState(category?.code ?? '');
  const [name, setName] = useState(category?.name ?? '');
  const [accountId, setAccountId] = useState<string | null>(category?.accountId ?? null);
  const [active, setActive] = useState(category?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!accountId) return setError(t('accounting.problems.account_required'));
    setBusy(true);
    const r =
      category === null
        ? await api('POST', '/api/accounting/categories', { code, name, accountId })
        : await api('PATCH', `/api/accounting/categories/${encodeURIComponent(category.id)}`, {
            name,
            accountId,
            active,
          });
    setBusy(false);
    if (r.status === 201 || r.status === 200) return onDone();
    setError(accountingRefusal(t, r.body));
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={category === null ? t('accounting.categories.new') : t('accounting.categories.edit')}
      description={t('accounting.categories.dialogHelp')}
      actionLabel={t('accounting.new.save')}
      cancelLabel={t('accounting.cancel')}
      busy={busy}
      onSubmit={() => void submit()}
    >
      <div className="grid gap-3.5 sm:grid-cols-2">
        <TextField
          label={t('accounting.accounts.code')}
          value={code}
          disabled={category !== null}
          onChange={(e) => setCode(e.target.value)}
        />
        <TextField
          label={t('accounting.accounts.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="sm:col-span-2">
          <AccountSelect
            label={t('accounting.fields.account')}
            accounts={expenseAccounts}
            value={accountId}
            onChange={setAccountId}
          />
        </div>
        {category !== null && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {t('accounting.categories.active')}
          </label>
        )}
      </div>
      <ErrorText text={error} />
    </FormDialog>
  );
}
