import type { CatalogLookups } from '@erp/contracts';
import { Alert, AlertDescription, AlertTitle } from '@erp/ui';
import { useTranslation } from 'react-i18next';

// Until the shop is live, the legacy app is where items change: the final import overwrites the catalog (owner answer
// 1 to W1-15). Every catalog screen says so.

export function LiveNotice({ lookups }: { lookups: CatalogLookups }) {
  const { t } = useTranslation();
  if (lookups.live) return null;
  return (
    <Alert>
      <AlertTitle>{t('catalog.notLive.title')}</AlertTitle>
      <AlertDescription>{t('catalog.notLive.text')}</AlertDescription>
    </Alert>
  );
}
