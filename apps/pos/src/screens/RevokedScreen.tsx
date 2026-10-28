import { Alert, AlertDescription, Button } from '@erp/ui';
import { useTranslation } from 'react-i18next';

import { CardScreen } from './Card';

/**
 * The server says this counter was revoked (sync spec §1, owner answer 3 to W1-07): it stops selling and keeps every
 * unsynced bill (rule 9). After a manager re-enables it in the back office, *Check again* brings it back.
 */
export function RevokedScreen({ waiting, onRetry }: { waiting: number; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col px-4 py-2.5">
      <CardScreen title={t('revoked.title')} wide role="alert">
        <Alert variant="destructive" role="none">
          <AlertDescription>{t('revoked.body', { count: waiting })}</AlertDescription>
        </Alert>
        <p className="m-0 text-muted-foreground">{t('revoked.help')}</p>
        <Button variant="outline" size="lg" onClick={onRetry}>
          {t('revoked.retry')}
        </Button>
      </CardScreen>
    </div>
  );
}
