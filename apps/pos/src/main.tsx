import { initBrowserSentry } from '@erp/observability/browser';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { App } from './App';
import { browserCounter } from './counter-browser';
import { i18n } from './i18n';
import './styles.css';

// Errors to Sentry (erp-web, D-086); the DSN and release are baked in at build time.
initBrowserSentry({
  app: 'pos',
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: import.meta.env.VITE_ERP_VERSION ?? 'dev',
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

document.title = i18n.t('app.title');

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App counter={browserCounter()} />
    </I18nextProvider>
  </StrictMode>,
);
