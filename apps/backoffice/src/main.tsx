import { initBrowserSentry } from '@erp/observability/browser';
import '@erp/ui/fonts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { httpApi } from './api';
import { App } from './App';
import { i18n } from './i18n';
import './styles.css';
import { applyTheme, readCachedTheme } from './theme';

// Errors to Sentry (erp-web, D-086); the DSN and release are baked in at build time.
initBrowserSentry({
  app: 'backoffice',
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: import.meta.env.VITE_ERP_VERSION ?? 'dev',
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

document.title = i18n.t('app.title');
// This browser's last theme until the person is known (W2-07); App applies theirs from /auth/me.
applyTheme(readCachedTheme());

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App api={httpApi()} />
    </I18nextProvider>
  </StrictMode>,
);
