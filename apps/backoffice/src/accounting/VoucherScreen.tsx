import type { AccountingLookups, VoucherView } from '@erp/contracts';
import { isEmptyDraft } from '@erp/domain';
import {
  Button,
  formatMoney,
  PageHeader,
  Panel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TextField,
  Input,
} from '@erp/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { moneyText, moneyValue } from '../catalog/data';
import { href, navigate } from '../router';
import {
  accountingRefusal,
  AccountSelect,
  ErrorText,
  LineEffectHint,
  PartyPicker,
  problemText,
  useAccountingLookups,
  voucherAccounts,
} from './data';

// A journal voucher (ACC-05, W1-19, D-108): a draft the accountant saves and finishes later, then posts once. The
// server checks it with the same rules (`checkJournalVoucher`); a posted one opens in the document view, where it can
// be reversed.

interface Line {
  accountId: string | null;
  party: { id: string; name: string } | null;
  debit: string;
  credit: string;
  memo: string;
}

const blank = (): Line => ({ accountId: null, party: null, debit: '', credit: '', memo: '' });

export function VoucherScreen({ api, id }: { api: Api; id: string }) {
  const { t } = useTranslation();
  const lookups = useAccountingLookups(api);
  const [view, setView] = useState<VoucherView | null | undefined>(id === 'new' ? null : undefined);
  const [date, setDate] = useState('');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = (v: VoucherView) => {
    setView(v);
    setDate(v.date);
    setNarration(v.narration ?? '');
    setLines(
      v.lines.map((l) => ({
        accountId: l.accountId,
        party: l.partyId ? { id: l.partyId, name: l.partyName ?? '' } : null,
        debit: l.debit ? moneyText(l.debit, lookups?.money.minorUnits ?? 2) : '',
        credit: l.credit ? moneyText(l.credit, lookups?.money.minorUnits ?? 2) : '',
        memo: l.memo ?? '',
      })),
    );
  };
  useEffect(() => {
    if (id === 'new' || lookups === null) return;
    let live = true;
    void api('GET', `/api/accounting/vouchers/${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (r.status !== 200) return setView(null);
      const v = r.body as VoucherView;
      if (v.status === 'posted') return navigate(href.accountingDocument('journal_voucher', v.id));
      show(v);
    });
    return () => {
      live = false;
    };
    // `show` reads the lookups only for the money format.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id, lookups]);

  if (lookups === null || view === undefined)
    return <p className="text-muted-foreground">{t('app.loading')}</p>;
  if (id !== 'new' && view === null) return <PageHeader title={t('accounting.document.notFound')} />;
  const units = lookups.money.minorUnits;
  const day = date || lookups.today;
  const accounts = voucherAccounts(lookups.accounts);
  const role = (accountId: string | null) => lookups.accounts.find((a) => a.id === accountId)?.role ?? null;

  const amounts = lines.map((l) => ({
    debit: moneyValue(l.debit, units),
    credit: moneyValue(l.credit, units),
  }));
  const debit = amounts.reduce((s, a) => s + (typeof a.debit === 'number' ? a.debit : 0), 0);
  const credit = amounts.reduce((s, a) => s + (typeof a.credit === 'number' ? a.credit : 0), 0);

  const draft = () => ({
    date: day,
    narration,
    lines: lines.map((l, i) => ({
      accountId: l.accountId,
      partyId: l.party?.id ?? null,
      debit: typeof amounts[i]!.debit === 'number' ? amounts[i]!.debit : 0,
      credit: typeof amounts[i]!.credit === 'number' ? amounts[i]!.credit : 0,
      memo: l.memo,
    })),
  });
  /** Saves the draft and returns it as the server checked it. A new one opens at its own address, unless it posts next. */
  const save = async (posting = false): Promise<VoucherView | null> => {
    if (amounts.some((a) => a.debit === undefined || a.credit === undefined)) {
      setError(t('accounting.problems.amount_invalid'));
      return null;
    }
    // Nothing on any line is nothing to keep (owner's review of W1-19); the server refuses it too.
    if (isEmptyDraft(draft().lines)) {
      setError(t('accounting.errors.empty_draft'));
      return null;
    }
    setBusy(true);
    const r =
      view === null
        ? await api('POST', '/api/accounting/vouchers', draft())
        : await api('PUT', `/api/accounting/vouchers/${encodeURIComponent(view.id)}`, {
            ...draft(),
            rowVersion: view.rowVersion,
          });
    setBusy(false);
    if (r.status === 201) {
      const made = (r.body as { id: string }).id;
      if (!posting) {
        navigate(href.voucher(made));
        return null;
      }
      const v = await api('GET', `/api/accounting/vouchers/${encodeURIComponent(made)}`);
      if (v.status === 200) return v.body as VoucherView;
      navigate(href.voucher(made));
      return null;
    }
    if (r.status === 200) {
      setError(null);
      show(r.body as VoucherView);
      return r.body as VoucherView;
    }
    setError(accountingRefusal(t, r.body));
    return null;
  };
  const post = async () => {
    const saved = await save(true);
    if (!saved) return;
    // A new draft that can't post yet opens at its own address, with what stops it.
    if (saved.check.problems.length > 0) return view === null ? navigate(href.voucher(saved.id)) : undefined;
    setBusy(true);
    const r = await api('POST', `/api/accounting/vouchers/${encodeURIComponent(saved.id)}/post`, {
      rowVersion: saved.rowVersion,
    });
    setBusy(false);
    if (r.status === 200) return navigate(href.accountingDocument('journal_voucher', saved.id));
    setError(accountingRefusal(t, r.body));
  };
  const remove = async () => {
    if (!view) return;
    setBusy(true);
    const r = await api(
      'DELETE',
      `/api/accounting/vouchers/${encodeURIComponent(view.id)}?rowVersion=${encodeURIComponent(view.rowVersion)}`,
    );
    setBusy(false);
    if (r.status === 200) return navigate(href.money);
    setError(accountingRefusal(t, r.body));
  };
  const set = (i: number, patch: Partial<Line>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader
        eyebrow={
          <a href={href.money} className="underline-offset-4 hover:underline">
            {t('accounting.money.title')}
          </a>
        }
        title={view === null ? t('accounting.voucher.new') : t('accounting.voucher.draftTitle')}
        help={t('accounting.voucher.help')}
        actions={
          lookups.can.journal && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void save()}>
                {t('accounting.voucher.save')}
              </Button>
              <Button disabled={busy || debit !== credit || debit === 0} onClick={() => void post()}>
                {t('accounting.voucher.post')}
              </Button>
              {view && (
                <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
                  {t('accounting.voucher.delete')}
                </Button>
              )}
            </div>
          )
        }
      />
      <Panel className="grid gap-3.5 p-3.5 sm:grid-cols-[12rem_1fr]">
        <TextField
          label={t('accounting.fields.date')}
          type="date"
          value={day}
          max={lookups.today}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          label={t('accounting.voucher.narration')}
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
        />
      </Panel>
      <Panel className="px-1.5 pb-2.5">
        <Table aria-label={t('accounting.voucher.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead className="w-80">{t('accounting.fields.account')}</TableHead>
              <TableHead>{t('accounting.fields.party')}</TableHead>
              <TableHead className="w-36 text-end">{t('accounting.fields.debit')}</TableHead>
              <TableHead className="w-36 text-end">{t('accounting.fields.credit')}</TableHead>
              <TableHead>{t('accounting.voucher.memo')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const r = role(l.accountId);
              const partyRole = r === 'AR_CONTROL' ? 'customer' : r === 'AP_CONTROL' ? 'supplier' : null;
              return (
                <TableRow key={i}>
                  <TableCell>
                    <AccountSelect
                      label={t('accounting.voucher.accountOf', { row: i + 1 })}
                      accounts={accounts}
                      value={l.accountId}
                      onChange={(accountId) => set(i, { accountId, party: null })}
                    />
                    <LineEffectHint
                      lookups={lookups}
                      accountId={l.accountId}
                      partyName={l.party?.name ?? null}
                      debit={amounts[i]!.debit ?? 0}
                      credit={amounts[i]!.credit ?? 0}
                    />
                  </TableCell>
                  <TableCell>
                    {partyRole && (
                      <PartyPicker
                        api={api}
                        label={t('accounting.voucher.partyOf', { row: i + 1 })}
                        role={partyRole}
                        picked={l.party}
                        onPick={(p) => set(i, { party: p ? { id: p.id, name: p.name } : null })}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={t('accounting.voucher.debitOf', { row: i + 1 })}
                      inputMode="decimal"
                      className="text-end"
                      value={l.debit}
                      onChange={(e) => set(i, { debit: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={t('accounting.voucher.creditOf', { row: i + 1 })}
                      inputMode="decimal"
                      className="text-end"
                      value={l.credit}
                      onChange={(e) => set(i, { credit: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label={t('accounting.voucher.memoOf', { row: i + 1 })}
                      value={l.memo}
                      onChange={(e) => set(i, { memo: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    {lines.length > 2 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t('accounting.voucher.removeLine', { row: i + 1 })}
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}
                      >
                        ×
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell colSpan={2}>
                <Button size="sm" variant="outline" onClick={() => setLines([...lines, blank()])}>
                  {t('accounting.voucher.addLine')}
                </Button>
              </TableCell>
              <TableCell className="text-end font-semibold tabular-nums">
                {formatMoney(debit, lookups.money)}
              </TableCell>
              <TableCell className="text-end font-semibold tabular-nums">
                {formatMoney(credit, lookups.money)}
              </TableCell>
              <TableCell colSpan={2} role="status">
                {debit !== credit
                  ? t('accounting.voucher.difference', {
                      amount: formatMoney(Math.abs(debit - credit), lookups.money),
                    })
                  : ''}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Panel>
      {view && view.check.problems.length > 0 && <Problems lookups={lookups} view={view} />}
      <ErrorText text={error} />
    </>
  );
}

function Problems({ view }: { lookups: AccountingLookups; view: VoucherView }) {
  const { t } = useTranslation();
  return (
    <ul className="m-0 list-disc ps-5 text-sm text-destructive" aria-label={t('accounting.voucher.problems')}>
      {view.check.problems.map((p, i) => (
        <li key={i}>{problemText(t, p.problem, p.row)}</li>
      ))}
    </ul>
  );
}
