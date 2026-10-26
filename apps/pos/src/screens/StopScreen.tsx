import { Alert, AlertDescription, Button } from '@erp/ui';
import { useTranslation } from 'react-i18next';

import type { StorageProblem } from '../storage/checks';
import { CardScreen } from './Card';

/** A storage check failed (POS spec §3): the counter stops, says what to do, and never offers to clear data. */
export function StopScreen({ problem }: { problem: StorageProblem }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col px-4 py-2.5">
      <CardScreen title={t('stop.title')} wide role="alert">
        <Alert variant="destructive" role="none">
          <AlertDescription>{t(`stop.${problem}`)}</AlertDescription>
        </Alert>
        <Button variant="outline" size="lg" onClick={() => window.location.reload()}>
          {t('stop.reload')}
        </Button>
      </CardScreen>
    </div>
  );
}
