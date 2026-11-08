import type { AccountingLookups, AccountRow, PartyHit } from '@erp/contracts';
import { Alert, AlertDescription, AlertTitle, Input } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from '../api';

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

/** Until go-live the books are kept in the legacy app (D-108); anything here is removed by the pilot wipe. */
export function AccountingNotice({ lookups }: { lookups: AccountingLookups }) {
  const { t } = useTranslation();
  if (lookups.live) return null;
  return (
    <Alert>
      <AlertTitle>{t('accounting.notLive.title')}</AlertTitle>
      <AlertDescription>{t('accounting.notLive.text')}</AlertDescription>
    </Alert>
  );
}

/** A customer or supplier, found by code, name or phone. */
export function PartyPicker({
  api,
  label,
  role,
  picked,
  onPick,
}: {
  api: Api;
  label: string;
  role: 'customer' | 'supplier' | 'any';
  picked: { id: string; name: string } | null;
  onPick: (party: PartyHit | null) => void;
}) {
  const { t } = useTranslation();
  // What was typed since the last pick; null shows the picked party's name.
  const [typed, setTyped] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; hits: PartyHit[] }>({ q: '', hits: [] });
  const listId = useId();
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
  const hits = q.length >= 2 && found.q === q ? found.hits : [];
  return (
    <div className="relative">
      <Input
        aria-label={label}
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        value={text}
        placeholder={t('accounting.party.search')}
        onChange={(e) => {
          setTyped(e.target.value);
          if (picked) onPick(null);
        }}
      />
      {hits.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute inset-x-0 top-full z-50 m-0 max-h-64 list-none overflow-auto rounded-md border border-input bg-surface p-1 shadow-md"
        >
          {hits.map((p) => (
            <li key={p.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full justify-between gap-3 rounded px-2 py-1.5 text-start hover:bg-surface-2"
                onClick={() => {
                  setTyped(null);
                  onPick(p);
                }}
              >
                <span>
                  <span className="font-mono text-xs text-muted-foreground">{p.code}</span> {p.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A select of accounts, shown as code and name. */
export function AccountSelect({
  id,
  label,
  accounts,
  value,
  onChange,
}: {
  id?: string;
  label: string;
  accounts: readonly AccountRow[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <select
      id={id}
      aria-label={label}
      className="h-11 w-full rounded-md border border-input bg-surface-2 px-2"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    >
      <option value="">{t('accounting.voucher.pickAccount')}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.code} {a.name}
        </option>
      ))}
    </select>
  );
}
