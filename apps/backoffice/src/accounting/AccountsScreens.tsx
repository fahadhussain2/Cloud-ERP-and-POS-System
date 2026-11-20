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
import { apiQuery, useFilters } from '../reports/frame/filters';
import { documentHref } from '../reports/frame/links';
import {
  ListTable,
  moneyText,
  PeriodFilter,
  periodOf,
  periodQuery,
  periodWords,
  ReportPage,
  useReport,
} from '../reports/frame/ReportFrame';
import { href } from '../router';
import { FormDialog } from '../staff/dialogs';
import { accountingRefusal, AccountSelect, ErrorText, useAccountingLookups } from './data';

// The chart with each account's balance at a date, an account's ledger with its running balance (part of ACC-07, owner
// answer 3 to W1-19), and the accountant's new accounts and expense categories (owner answer 4). Banks, wallets and
// roles stay a setup job.

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
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-[8rem_1fr]">
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

/** One account's lines in a period, with its opening and running balance (W1-19), on the report frame (W2-01). */
export function LedgerScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const [filters, setFilters] = useFilters('ledger');
  const period = periodOf(filters, 'thisMonth');
  const url = `/api/accounting/accounts/${encodeURIComponent(id)}/ledger?${apiQuery(periodQuery(period))}`;
  const { report: ledger, error } = useReport<LedgerView>(api, url);
  const lookups = useAccountingLookups(api);
  const m = lookups?.money ?? null;
  const title = ledger ? `${ledger.account.code} ${ledger.account.name}` : t('nav.accountLedger');
  type Line = LedgerView['lines'][number] & { i: number };
  const lines: Line[] = ledger?.lines.map((l, i) => ({ ...l, i })) ?? [];
  return (
    <ReportPage
      eyebrow={
        <a href={href.accounts} className="underline-offset-4 hover:underline print:hidden">
          {t('accounting.accounts.title')}
        </a>
      }
      title={title}
      help={t('accounting.ledger.help')}
      filters={<PeriodFilter value={period} shown={ledger} onChange={(p) => setFilters(periodQuery(p))} />}
      printFilters={periodWords(ledger)}
      csv={ledger && `${url}&format=csv`}
      error={error}
      loading={ledger === null || m === null}
      figures={
        ledger && m
          ? [
              { key: 'opening', label: t('accounting.ledger.opening'), value: moneyText(ledger.opening, m) },
              { key: 'closing', label: t('accounting.ledger.closing'), value: moneyText(ledger.closing, m) },
            ]
          : []
      }
    >
      {ledger && m && (
        <>
          <ListTable<Line>
            label={t('accounting.ledger.lines')}
            rows={lines}
            rowKey={(l) => String(l.i)}
            text={(l) => `${l.journalNumber} ${l.number ?? ''} ${l.memo ?? ''} ${l.partyName ?? ''}`}
            columns={[
              {
                key: 'date',
                label: t('accounting.fields.date'),
                sort: (l) => `${l.date} ${l.i}`,
                cell: (l) => l.date,
              },
              {
                key: 'journal',
                label: t('accounting.ledger.journal'),
                cell: (l) => {
                  const link = documentHref(l.sourceType, l.sourceId, l.number);
                  return link ? (
                    <a href={link} className="font-mono underline-offset-4 hover:underline">
                      {l.journalNumber}
                    </a>
                  ) : (
                    <span className="font-mono">{l.journalNumber}</span>
                  );
                },
              },
              { key: 'memo', label: t('accounting.ledger.memo'), cell: (l) => l.memo ?? '' },
              { key: 'party', label: t('accounting.fields.party'), cell: (l) => l.partyName ?? '' },
              {
                key: 'debit',
                label: t('accounting.fields.debit'),
                end: true,
                sort: (l) => l.debit,
                cell: (l) => moneyText(l.debit, m, true),
              },
              {
                key: 'credit',
                label: t('accounting.fields.credit'),
                end: true,
                sort: (l) => l.credit,
                cell: (l) => moneyText(l.credit, m, true),
              },
              {
                key: 'balance',
                label: t('accounting.accounts.balance'),
                end: true,
                cell: (l) => moneyText(l.balance, m),
              },
            ]}
            footer={[t('accounting.ledger.closing'), '', '', '', '', '', moneyText(ledger.closing, m)]}
          />
          {ledger.truncated && (
            <p className="m-0 px-2 text-sm text-warn">{t('accounting.ledger.truncated')}</p>
          )}
        </>
      )}
    </ReportPage>
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
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
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
