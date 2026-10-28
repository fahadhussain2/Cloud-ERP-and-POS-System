import { Button, Kbd } from '@erp/ui';
import { useTranslation } from 'react-i18next';

import type { PaymentMethodRow } from '../db/checkout';

// The payment pad under the total (POS spec §12, POS-17): it never moves. Cash first and largest, then the tenant's
// other active methods in their order, On account (from W1-09) and Split payment.

export function PaymentPad({
  methods,
  disabled,
  onCash,
  onMethod,
  onSplit,
}: {
  methods: readonly PaymentMethodRow[];
  /** While the bill is empty. */
  disabled: boolean;
  onCash: () => void;
  onMethod: (method: PaymentMethodRow) => void;
  onSplit: () => void;
}) {
  const { t } = useTranslation();
  const others = methods.filter((m) => !m.isCash && m.code !== 'on_account');
  const onAccount = methods.find((m) => m.code === 'on_account');
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
        // A credit customer can be chosen from W1-09.
        <Button type="button" variant="outline" className="h-12 flex-1" disabled>
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
