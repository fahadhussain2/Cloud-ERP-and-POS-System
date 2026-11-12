import { initBrowserSentry } from '@erp/observability/browser';
import '@erp/ui/fonts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { registerSW } from 'virtual:pwa-register';

import { App } from './App';
import { isBillOpen } from './bill/bill-open';
import { browserCounter } from './counter-browser';
import { i18n } from './i18n';
import { applyUpdateWhenSafe } from './pwa/update';
import './styles.css';

// Errors to Sentry (erp-web, D-086); the DSN and release are baked in at build time.
initBrowserSentry({
  app: 'pos',
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: import.meta.env.VITE_ERP_VERSION ?? 'dev',
});

// The app shell offline (POS spec §8): a new version waits while someone has lines on their bill.
const updateSW = registerSW({
  onNeedRefresh: () => applyUpdateWhenSafe({ activate: () => void updateSW(true), billOpen: isBillOpen }),
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
