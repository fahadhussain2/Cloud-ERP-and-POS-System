import * as Sentry from '@sentry/react';

import { scrubEvent, type EventLike } from './sentry-scrub';

// Sentry for the POS and the back office (D-086), project erp-web. The DSN and the release are baked in at build
// time (VITE_SENTRY_DSN, VITE_ERP_VERSION); without a DSN (tests, local runs) nothing is sent.

const PRODUCTION_HOSTS = /^(app|pos)\.zorbixtechnologies\.com$/;

/** prod, staging or dev, from the host the page is served on. */
export function envFromHost(host: string): 'prod' | 'staging' | 'dev' {
  if (PRODUCTION_HOSTS.test(host)) return 'prod';
  if (host.startsWith('staging-')) return 'staging';
  return 'dev';
}

export function initBrowserSentry(opts: {
  app: 'pos' | 'backoffice';
  dsn: string | undefined;
  release: string;
}): void {
  if (!opts.dsn) return;
  Sentry.init({
    dsn: opts.dsn,
    environment: envFromHost(window.location.hostname),
    release: opts.release,
    initialScope: { tags: { app: opts.app } },
    sendDefaultPii: false,
    // Errors only: no performance tracing or session replay on the free plan (D-086).
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event as unknown as EventLike) as unknown as typeof event,
  });
}
