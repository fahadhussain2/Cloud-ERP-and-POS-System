import { normalizePhone, sub } from '@erp/domain';
import { Alert, AlertDescription, formatMoney, Input, moveSelection, OptionList, TextField } from '@erp/ui';
import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { BillCustomer } from '../bill/open-bill';
import type { CounterCustomer } from '../db/customers';
import { maskPhone, searchCustomers } from '../search/customer-search';
import type { Tier } from '../search/search-index';
import { FormDialog } from './BillDialogs';

// The customer dialog (`F4`, POS spec §15, POS-05): one search over this counter's customers by name, phone or code,
// the same offline. Walk-in is the first row, with an optional phone so the bill can be found later without a receipt.
// Enter picks; Esc leaves the bill as it was. A phone shows only its last four digits (owner answer 4).

export interface CustomerChoice {
  customer: CounterCustomer | null;
  walkinPhone: string | null;
}

type Row = { kind: 'walkin' } | { kind: 'customer'; customer: CounterCustomer };

export function CustomerDialog({
  customers,
  tiers,
  current,
  walkinPhone,
  money,
  onChoose,
  onClose,
}: {
  customers: readonly CounterCustomer[];
  tiers: readonly Tier[];
  /** The bill's customer now, if any. */
  current: BillCustomer | null;
  walkinPhone: string | null;
  money: { locale: string; currency: string; minorUnits: number };
  onChoose: (choice: CustomerChoice) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, money);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [phone, setPhone] = useState(walkinPhone ?? '');
  const [error, setError] = useState<string | null>(null);
  const found = text.trim() === '' ? [] : searchCustomers(customers, text);
  // With a customer on the bill and nothing typed, they come first: Enter keeps them, ↓ goes back to walk-in.
  const own = current ? customers.find((c) => c.id === current.id) : undefined;
  const walkin: Row = { kind: 'walkin' };
  const rows: Row[] =
    text.trim() === '' && own
      ? [{ kind: 'customer', customer: own }, walkin]
      : [walkin, ...found.map((customer): Row => ({ kind: 'customer', customer }))];
  const [selected, setSelected] = useState(0);
  const at = Math.min(selected, rows.length - 1);

  const choose = (i = at) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === 'customer') return onChoose({ customer: row.customer, walkinPhone: null });
    if (phone.trim() === '') return onChoose({ customer: null, walkinPhone: null });
    if (normalizePhone(phone) === null) return setError(t('customer.badPhone'));
    onChoose({ customer: null, walkinPhone: phone.trim() });
  };

  const tierName = (id: string) => tiers.find((x) => x.id === id)?.name ?? '';
  const credit = (c: CounterCustomer) => {
    if (!c.account.creditAllowed) return t('customer.noCredit');
    const limit = c.account.creditLimit;
    return [
      t('customer.balance', { amount: m(c.balance) }),
      limit === null
        ? t('customer.noLimit')
        : t('customer.available', { amount: m(sub(limit, c.balance)), limit: m(limit) }),
    ].join(' · ');
  };

  return (
    <FormDialog
      title={t('customer.title')}
      description={t('customer.help')}
      actionLabel={t('customer.action')}
      onClose={onClose}
      onSubmit={() => choose()}
    >
      <Input
        ref={input}
        aria-label={t('customer.search')}
        placeholder={t('customer.search')}
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls="customer-results"
        autoComplete="off"
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          const next = moveSelection(at, e.key, rows.length);
          if (next === null) return;
          e.preventDefault();
          setSelected(next);
        }}
      />
      <OptionList
        id="customer-results"
        label={t('customer.title')}
        items={rows}
        selected={at}
        itemKey={(r) => (r.kind === 'walkin' ? 'walk-in' : r.customer.id)}
        onSelect={(i) => {
          setSelected(i);
          input.current?.focus();
        }}
        onChoose={(i) => choose(i)}
        className="max-h-[45vh]"
      >
        {(r) =>
          r.kind === 'walkin' ? (
            <div className="px-2 py-1.5 font-semibold">{t('customer.walkIn')}</div>
          ) : (
            <div className="grid grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-2.5 px-2 py-1.5">
              <span className="font-mono text-[12.5px] font-semibold">{r.customer.code}</span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium wrap-anywhere">{r.customer.name}</span>
                <span className="text-xs text-muted-foreground">
                  {[r.customer.city, r.customer.phones[0] && maskPhone(r.customer.phones[0])]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <span className="flex flex-col items-end text-xs">
                <span className="font-semibold">{tierName(r.customer.account.tierId)}</span>
                <span className="text-muted-foreground tabular-nums">{credit(r.customer)}</span>
              </span>
            </div>
          )
        }
      </OptionList>
      {text.trim() !== '' && found.length === 0 && (
        <p className="m-0 text-muted-foreground">{t('customer.none', { text: text.trim() })}</p>
      )}
      {rows[at]?.kind === 'walkin' && (
        <TextField
          label={t('customer.walkinPhone')}
          inputMode="tel"
          autoComplete="off"
          className="font-mono"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setError(null);
          }}
        />
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </FormDialog>
  );
}

/** The bill's context strip for a customer (POS spec §15): name and code, and for credit their balance and room. */
export function customerStrip(c: CounterCustomer, t: TFunction, m: (minor: number) => string): string {
  const parts = [`${c.name} (${c.code})`];
  if (c.account.creditAllowed) {
    const limit = c.account.creditLimit;
    parts.push(
      t('customer.balance', { amount: m(c.balance) }),
      limit === null
        ? t('customer.noLimit')
        : t('customer.availableShort', { amount: m(sub(limit, c.balance)) }),
    );
  }
  return parts.join(' · ');
}
