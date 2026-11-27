import type { AccountingLookups, AccountRow, PartyHit } from '@erp/contracts';
import { lineEffect } from '@erp/domain';
import { formatMoney } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';
import { ListPicker, SearchBox } from '../ui';

// What the accounting screens share (W1-19, D-108): the lookups (banks, categories, the chart, the shop's day and lock
// date, what this person may do), the words for a problem or a refusal, and the pickers for a party and an account.

export function useAccountingLookups(api: Api, version = 0): AccountingLookups | null {
  const [lookups, setLookups] = useState<AccountingLookups | null>(null);
  const fetchIt = useCallback(async () => {
    const r = await api('GET', '/api/accounting/lookups');
    return r.status === 200 ? (r.body as AccountingLookups) : null;
  }, [api]);
  useEffect(() => {
    let live = true;
    void fetchIt().then((l) => live && setLookups(l));
    return () => {
      live = false;
    };
  }, [fetchIt, version]);
  return lookups;
}

const exists = (t: TFunction, key: string) => t(key, { defaultValue: '' }) !== '';

/** The words for a problem code, with its row when it has one. */
export function problemText(t: TFunction, problem: string, row: number | null = null) {
  const key = `accounting.problems.${problem}`;
  const text = exists(t, key) ? t(key) : problem;
  return row === null ? text : t('accounting.problems.row', { row: row + 1, text });
}

/** The words for a refusal from the accounting API. */
export function accountingRefusal(t: TFunction, body: unknown): string {
  const b = body as {
    error?: string;
    problems?: (string | { problem: string; row: number | null })[];
    by?: string | null;
    code?: string;
    lockDate?: string;
  } | null;
  if (b?.error === 'invalid' && b.problems?.length)
    return b.problems
      .map((p) => (typeof p === 'string' ? problemText(t, p) : problemText(t, p.problem, p.row)))
      .join(' ');
  if (b?.error === 'stale')
    return t('accounting.errors.stale', { by: b.by ?? t('accounting.errors.someone') });
  if (b?.error === 'posting_failed') return t('accounting.errors.posting_failed', { code: b.code ?? '' });
  if (b?.error === 'date_locked') return t('accounting.errors.date_locked', { date: b.lockDate ?? '' });
  if (b?.error && exists(t, `accounting.errors.${b.error}`)) return t(`accounting.errors.${b.error}`);
  return t('app.error');
}

/** A bank account's name, or the safe's (the CASH_SAFE account's name). */
export function placeName(lookups: AccountingLookups, id: string | null): string {
  if (id === null || id === 'safe')
    return lookups.accounts.find((a) => a.role === 'CASH_SAFE')?.name ?? 'safe';
  return lookups.banks.find((b) => b.id === id)?.name ?? '—';
}

/** Accounts a voucher may use: postable, active, not one the system keeps (D-108). */
export const VOUCHER_KEPT = new Set(['INVENTORY', 'CASH_DRAWER', 'CASH_IN_TRANSIT']);
export const voucherAccounts = (accounts: readonly AccountRow[]) =>
  accounts.filter((a) => a.postable && a.active && !(a.role !== null && VOUCHER_KEPT.has(a.role)));

export function ErrorText({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="m-0 text-sm text-destructive">
      {text}
    </p>
  ) : null;
}

/**
 * A customer or supplier, found by code, name or phone. ↑ ↓ move through the hits and Enter takes the highlighted one
 * (W2-13); Esc closes the list until the text changes.
 */
export function PartyPicker({
  api,
  label,
  role,
  picked,
  onPick,
  error,
}: {
  api: Api;
  label: string;
  role: 'customer' | 'supplier' | 'any';
  picked: { id: string; name: string } | null;
  onPick: (party: PartyHit | null) => void;
  /** The field's problem, shown under it (owner answer 6). */
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  // What was typed since the last pick; null shows the picked party's name.
  const [typed, setTyped] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; hits: PartyHit[] }>({ q: '', hits: [] });
  // The text whose list Esc closed.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const text = typed ?? picked?.name ?? '';
  const q = typed?.trim() ?? '';
  useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      void api('GET', `/api/accounting/parties?role=${role}&q=${encodeURIComponent(q)}`).then(
        (r) => live && setFound({ q, hits: r.status === 200 ? (r.body as PartyHit[]) : [] }),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, q, role]);
  const hits = q.length >= 2 && found.q === q && closedFor !== q ? found.hits : NO_HITS;
  return (
    <SearchBox
      label={label}
      listLabel={label}
      placeholder={t('accounting.party.search')}
      text={text}
      onText={(v) => {
        setTyped(v);
        if (picked) onPick(null);
      }}
      hits={hits}
      hitKey={(p) => p.id}
      onPick={(p) => {
        setTyped(null);
        onPick(p);
      }}
      onEscape={() => setClosedFor(q)}
      error={error}
    >
      {(p) => (
        <>
          <span className="font-mono text-xs text-muted-foreground">{p.code}</span> {p.name}
        </>
      )}
    </SearchBox>
  );
}
const NO_HITS: PartyHit[] = [];

/**
 * An account, searched by code or name (owner answer 3: the chart of accounts is a list that keeps growing; W2-15).
 * `hideLabel` in a table cell, whose column names it.
 */
export function AccountSelect({
  label,
  accounts,
  value,
  onChange,
  hideLabel = false,
  error,
}: {
  label: string;
  accounts: readonly AccountRow[];
  value: string | null;
  onChange: (id: string | null) => void;
  hideLabel?: boolean;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ListPicker
      label={label}
      hideLabel={hideLabel}
      placeholder={t('accounting.voucher.pickAccount')}
      options={accounts}
      value={value ?? ''}
      error={error}
      onChange={(id) => onChange(id === '' ? null : id)}
    />
  );
}

/**
 * What a voucher or journal line does to its account, under the account (owner's review of W1-19): "↑ Bank charges
 * goes up Rs 2,000", or in a customer's or supplier's words. Nothing while the account or the amount isn't there yet.
 * The arrow says it as well as the colour.
 */
export function LineEffectHint({
  lookups,
  accountId,
  partyName,
  debit,
  credit,
}: {
  lookups: AccountingLookups;
  accountId: string | null;
  partyName: string | null;
  debit: number | undefined;
  credit: number | undefined;
}) {
  const { t } = useTranslation();
  const account = lookups.accounts.find((a) => a.id === accountId);
  if (!account || debit === undefined || credit === undefined) return null;
  const effect = lineEffect(account, debit, credit);
  if (!effect) return null;
  const amount = formatMoney(effect.amount, lookups.money);
  const up = effect.direction === 'up';
  const text =
    effect.kind === 'owes_you'
      ? t(up ? 'accounting.effect.owesYouMore' : 'accounting.effect.owesYouLess', {
          name: partyName ?? t('accounting.effect.customer'),
          amount,
        })
      : effect.kind === 'you_owe'
        ? t(up ? 'accounting.effect.youOweMore' : 'accounting.effect.youOweLess', {
            name: partyName ?? t('accounting.effect.supplier'),
            amount,
          })
        : t(up ? 'accounting.effect.up' : 'accounting.effect.down', { name: account.name, amount });
  return <p className={`m-0 mt-1 text-xs font-medium ${up ? 'text-ok' : 'text-warn'}`}>{text}</p>;
}
