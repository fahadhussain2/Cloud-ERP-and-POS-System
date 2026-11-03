import { Button, Kbd } from '@erp/ui';
import { useTranslation } from 'react-i18next';

import type { PaymentMethodRow } from '../db/checkout';

// The payment pad under the total (POS spec §12, POS-17): it never moves. Cash first and largest, then the tenant's
// other active methods in their order, On account (for a credit customer, POS spec §15) and Split payment. When money
// goes back (a return, W1-13, POS spec §19) it switches to Refund cash at desk / Credit to account / Refund by transfer,
// and when the net is zero to Finalize even exchange (D-053).

/** What the pad offers: paying, refunding, or an even exchange. */
export type PadMode = 'pay' | 'refund' | 'even';

export function PaymentPad({
  methods,
  disabled,
  onCash,
  onMethod,
  onAccount: onAccountClick,
  onAccountBlocked,
  onSplit,
  mode = 'pay',
  onRefund,
  refundAccountBlocked = null,
  onEven,
}: {
  methods: readonly PaymentMethodRow[];
  /** While the bill is empty. */
  disabled: boolean;
  onCash: () => void;
  onMethod: (method: PaymentMethodRow) => void;
  onAccount: () => void;
  /** Why On account can't be used on this bill (an i18n text), or null when it can. */
  onAccountBlocked: string | null;
  onSplit: () => void;
  mode?: PadMode;
  onRefund?: (to: 'cash' | 'account' | 'transfer') => void;
  /** Why a refund can't go to an account (an i18n text), or null when it can. */
  refundAccountBlocked?: string | null;
  onEven?: () => void;
}) {
  const { t } = useTranslation();
  const others = methods.filter((m) => !m.isCash && m.code !== 'on_account');
  const onAccount = methods.find((m) => m.code === 'on_account');
  if (mode === 'even')
    return (
      <div className="flex flex-wrap gap-1.5 pt-2" role="group" aria-label={t('pay.pad')}>
        <Button
          type="button"
          size="lg"
          className="h-12 min-w-[150px] flex-1 text-lg font-bold"
          disabled={disabled}
          aria-keyshortcuts="F9"
          onClick={onEven}
        >
          {t('refund.even')}{' '}
          <Kbd aria-hidden className="border-current bg-transparent text-inherit">
            F9
          </Kbd>
        </Button>
      </div>
    );
  if (mode === 'refund')
    return (
      <div className="flex flex-wrap gap-1.5 pt-2" role="group" aria-label={t('pay.pad')}>
        <Button
          type="button"
          size="lg"
          className="h-12 min-w-[150px] flex-[2] bg-warn text-lg font-bold text-white hover:bg-warn/90"
          disabled={disabled}
          aria-keyshortcuts="F9"
          onClick={() => onRefund?.('cash')}
        >
          {t('refund.cash')}{' '}
          <Kbd aria-hidden className="border-current bg-transparent text-inherit">
            F9
          </Kbd>
        </Button>
        {onAccount && (
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1"
            disabled={disabled || refundAccountBlocked !== null}
            title={refundAccountBlocked ?? undefined}
            onClick={() => onRefund?.('account')}
          >
            {t('refund.account')}
          </Button>
        )}
        {others.length > 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-12 flex-1"
            disabled={disabled}
            onClick={() => onRefund?.('transfer')}
          >
            {t('refund.transfer')}
          </Button>
        )}
      </div>
    );
  return (
    <div className="flex flex-wrap gap-1.5 pt-2" role="group" aria-label={t('pay.pad')}>
      <Button
        type="button"
        size="lg"
        className="h-12 min-w-[150px] flex-[2] text-lg font-bold"
        disabled={disabled}
        aria-keyshortcuts="F9"
        onClick={onCash}
      >
        {t('pay.cash')}{' '}
        <Kbd aria-hidden className="border-current bg-transparent text-inherit">
          F9
        </Kbd>
      </Button>
      {others.map((m) => (
        <Button
          key={m.code}
          type="button"
          variant="outline"
          className="h-12 flex-1"
          disabled={disabled}
          onClick={() => onMethod(m)}
        >
          {m.name}
        </Button>
      ))}
      {onAccount && (
        <Button
          type="button"
          variant="outline"
          className="h-12 flex-1"
          disabled={disabled || onAccountBlocked !== null}
          title={onAccountBlocked ?? undefined}
          onClick={onAccountClick}
        >
          {onAccount.name}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        className="h-12 flex-1"
        disabled={disabled}
        aria-keyshortcuts="Shift+F9"
        onClick={onSplit}
      >
        {t('pay.split')} <Kbd aria-hidden>Shift+F9</Kbd>
      </Button>
    </div>
  );
}
