import { useTranslation } from 'react-i18next';

export function App() {
  const { t } = useTranslation();

  return (
    <main className="placeholder">
      <h1>{t('app.title')}</h1>
      <p>{t('app.placeholder')}</p>
    </main>
  );
}
