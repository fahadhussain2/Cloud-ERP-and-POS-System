import type { PurchasingLookups } from '@erp/contracts';
import { Alert, AlertDescription, AlertTitle } from '@erp/ui';
import { useTranslation } from 'react-i18next';

// Until the shop is live, purchases go into the legacy app (owner answer 4 to W1-16); practice bills here are removed
// by the pilot wipe. Every purchasing screen says so.

export function PurchasingNotice({ lookups }: { lookups: PurchasingLookups }) {
  const { t } = useTranslation();
  if (lookups.live) return null;
  return (
    <Alert>
      <AlertTitle>{t('purchasing.notLive.title')}</AlertTitle>
      <AlertDescription>{t('purchasing.notLive.text')}</AlertDescription>
    </Alert>
  );
}
