import {
  hasListPrice,
  negate,
  sub,
  type Approval,
  type BillAmounts,
  type PendingApproval,
  type SaleTotal,
} from '@erp/domain';
import {
  Alert,
  AlertDescription,
  Badge,
  cn,
  formatMoney,
  OptionList,
  Panel,
  type MoneyFormat,
} from '@erp/ui';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';

import { formatQty } from '../bill/bill-state';
import type { OpenBill } from '../bill/open-bill';
import { maskPhone } from '../search/customer-search';

// The bill on the counter screen (POS spec §10, prototype layout): what the bill is priced at, the lines with their
// list price, floor and chips, and the totals pinned at the bottom with the payment pad under them (POS spec §12).

const chip = 'border-transparent font-semibold';

export function BillPanel({
  openBill,
  amounts,
  total,
  pending,
  tierName,
  customerText,
  walkinPhone,
  selected,
  active,
  message,
  notice,
  money,
  nameOf,
  pad,
  panelRef,
  onSelect,
  onKeyDown,
}: {
  openBill: OpenBill | null;
  amounts: BillAmounts | null;
  /** The total rounded to the tenant's increment (POS-15); null until the checkout settings have loaded. */
  total: SaleTotal | null;
  pending: readonly PendingApproval[];
  tierName: string;
  /** The customer and their credit (POS spec §15); null for a walk-in. */
  customerText: string | null;
  /** A walk-in's phone, shown by its last four digits. */
  walkinPhone: string | null;
  /** The selected line, when the lines have the keyboard. */
  selected: number;
  active: boolean;
  /** What the last key could not do (an i18n text). */
  message: string | null;
  /** What the last bill came to (an i18n text), shown until the next one starts. */
  notice: string | null;
  money: MoneyFormat;
  /** A person's name, for "Approved by". */
  nameOf: (userId: string) => string;
  /** The payment pad, under the total. */
  pad: ReactNode;
  panelRef: Ref<HTMLElement>;
  onSelect: (index: number) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, money);
  const approvedBy = (a: Approval<unknown>) =>
    t('bill.approved', { name: nameOf(a.approvedBy), reason: t(`override.reason.${a.reason}`) });
  const lines = openBill?.bill.lines ?? [];
  const lineNeeds = new Set(pending.flatMap((p) => (p.target === 'bill' ? [] : [p.target.lineId])));
  const billNeeds = pending.some((p) => p.target === 'bill');
  const billApproval = openBill?.bill.billApproval ?? null;

  return (
    <Panel
      ref={panelRef}
      tabIndex={-1}
      aria-label={t('bill.title')}
      onKeyDown={onKeyDown}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden outline-none',
        active && 'border-focus shadow-[0_0_0_1px_var(--focus)]',
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-3.5 pt-2.5 pb-1">
        <h2 className="m-0 font-display text-[15px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
          {t('bill.title')}
        </h2>
        <span className="text-sm">
          {customerText ??
            (walkinPhone ? t('bill.walkInPhone', { phone: maskPhone(walkinPhone) }) : t('bill.walkIn'))}{' '}
          · <span className="font-semibold">{t('bill.tierPrices', { tier: tierName })}</span>
        </span>
      </div>
      {message && (
        <Alert variant="destructive" className="mx-3.5 mb-1 w-auto">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <div
          role="status"
          className="mx-3.5 mb-1 rounded-lg border border-ok bg-ok-soft px-3 py-2 font-semibold text-ok"
        >
          {notice}
        </div>
      )}
      {openBill === null ? (
        <p className="m-0 px-3.5 py-4 text-muted-foreground">{t('bill.loading')}</p>
      ) : lines.length === 0 ? (
        <p className="m-0 flex-1 px-3.5 py-4 text-muted-foreground">{t('bill.empty')}</p>
      ) : (
        <>
          <div className="grid grid-cols-[22px_minmax(0,1fr)_52px_86px_96px] gap-2 px-5 pb-1 text-[11px] font-semibold tracking-[.06em] text-muted-foreground uppercase">
            <span>{t('bill.head.no')}</span>
            <span>{t('bill.head.item')}</span>
            <span className="text-end">{t('bill.head.qty')}</span>
            <span className="text-end">{t('bill.head.price')}</span>
            <span className="text-end">{t('bill.head.amount')}</span>
          </div>
          <OptionList
            id="bill-lines"
            label={t('keys.lines')}
            items={lines}
            selected={active ? selected : -1}
            itemKey={(l) => l.id}
            onSelect={onSelect}
            className="flex-1 px-1.5 pb-2"
          >
            {(l) => {
              const i = lines.indexOf(l);
              const a = amounts!.lines[i]!;
              const item = openBill.items[l.itemId];
              const below = a.amount < a.listAmount;
              const above = hasListPrice(l.list) && a.amount > a.listAmount;
              return (
                <div className="grid grid-cols-[22px_minmax(0,1fr)_52px_86px_96px] items-center gap-2 px-2 py-[7px]">
                  <span className="text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium wrap-anywhere">{item?.name ?? l.itemId}</span>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{item?.code}</span>
                      <span>
                        {hasListPrice(l.list) ? t('bill.list', { price: m(l.list) }) : t('bill.noList')}
                      </span>
                      <span>
                        {l.floor !== null ? t('bill.floor', { price: m(l.floor) }) : t('bill.noFloor')}
                      </span>
                      {lineNeeds.has(l.id) ? (
                        <Badge variant="outline" className={cn(chip, 'bg-bad-soft text-bad')}>
                          {t('bill.needsApproval')}
                        </Badge>
                      ) : l.approval ? (
                        <Badge variant="outline" className={cn(chip, 'bg-primary-soft text-primary')}>
                          {approvedBy(l.approval)}
                        </Badge>
                      ) : below ? (
                        <Badge
                          variant="outline"
                          className={cn(chip, 'border-line bg-surface-2 text-muted-foreground')}
                        >
                          {t('bill.bargained', { amount: m(sub(a.listAmount, a.amount)) })}
                        </Badge>
                      ) : above ? (
                        <Badge variant="outline" className={cn(chip, 'bg-warn-soft text-warn')}>
                          {t('bill.aboveList')}
                        </Badge>
                      ) : null}
                    </span>
                  </span>
                  <span className="text-end tabular-nums">×{formatQty(l.qty, money.locale)}</span>
                  <span className="text-end tabular-nums">{m(l.unitPrice)}</span>
                  <span className="text-end font-semibold tabular-nums">{m(a.amount)}</span>
                </div>
              );
            }}
          </OptionList>
        </>
      )}
      {amounts && lines.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line bg-surface-2 px-3.5 pt-2.5 pb-3">
          <div className="flex justify-between gap-3 text-muted-foreground tabular-nums">
            <span>{t('bill.lines', { count: lines.length })}</span>
            <span>
              {t('bill.subtotal')} {m(amounts.subtotal)}
            </span>
          </div>
          {amounts.lineDiscountTotal !== 0 && (
            <div className="flex justify-between gap-3 text-muted-foreground tabular-nums">
              {/* Bargained lines take money off; lines above list add it (the sign comes with the amount). */}
              <span>{t(amounts.lineDiscountTotal > 0 ? 'bill.lineDiscounts' : 'bill.aboveListTotal')}</span>
              <span>{m(negate(amounts.lineDiscountTotal))}</span>
            </div>
          )}
          {amounts.billDiscount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
              <span className="flex flex-wrap items-center gap-2">
                {t('bill.billDiscount')}
                {billNeeds ? (
                  <Badge variant="outline" className={cn(chip, 'bg-bad-soft text-bad')}>
                    {t('bill.billNeedsApproval')}
                  </Badge>
                ) : (
                  billApproval && (
                    <Badge variant="outline" className={cn(chip, 'bg-primary-soft text-primary')}>
                      {t('bill.billApproved', {
                        name: nameOf(billApproval.approvedBy),
                        reason: t(`override.reason.${billApproval.reason}`),
                      })}
                    </Badge>
                  )
                )}
              </span>
              <span>{m(negate(amounts.billDiscount))}</span>
            </div>
          )}
          {total !== null && total.rounding !== 0 && (
            <div className="flex justify-between gap-3 text-muted-foreground tabular-nums">
              <span>{t('bill.rounding')}</span>
              <span data-testid="bill-rounding">{m(total.rounding)}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display text-lg font-semibold tracking-[.05em] uppercase">
              {t('bill.total')}
            </span>
            <span
              className="font-display text-[40px] leading-none font-bold tabular-nums"
              data-testid="bill-total"
            >
              {m(total?.total ?? amounts.total)}
            </span>
          </div>
        </div>
      )}
      <div className="border-t border-line bg-surface-2 px-3.5 pb-3">{pad}</div>
    </Panel>
  );
}
