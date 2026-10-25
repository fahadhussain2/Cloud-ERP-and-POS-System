import { useTranslation } from 'react-i18next';

import type { StorageProblem } from '../storage/checks';

/** A storage check failed (POS spec §3): the counter stops, says what to do, and never offers to clear data. */
export function StopScreen({ problem }: { problem: StorageProblem }) {
  const { t } = useTranslation();
  return (
    <main className="screen stop" role="alert">
      <h1>{t('stop.title')}</h1>
      <p>{t(`stop.${problem}`)}</p>
      <button type="button" onClick={() => window.location.reload()}>
        {t('stop.reload')}
      </button>
    </main>
  );
}
