import * as Sentry from '@sentry/node';

import { currentContext } from './context';

// Sentry for the server apps (D-086). Events never carry cookies, credential headers or request bodies
// (architecture §11.7).

interface EventLike {
  request?: {
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, string>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key']);

/** Used as Sentry's beforeSend: strips what could hold a secret or personal data. */
export function scrubEvent<E extends EventLike>(event: E): E {
  if (!event.request) return event;
  const request = Object.fromEntries(
    Object.entries(event.request).filter(([k]) => k !== 'cookies' && k !== 'data' && k !== 'headers'),
  );
  const headers = event.request.headers;
  const kept = headers
    ? Object.fromEntries(Object.entries(headers).filter(([k]) => !DROPPED_HEADERS.has(k.toLowerCase())))
    : undefined;
  return { ...event, request: { ...request, ...(kept ? { headers: kept } : {}) } };
}

export interface ErrorReporter {
  /** Sends `err` with the request ID and the current context (tenant, user, device) as tags. */
  capture: (err: unknown, requestId?: string) => void;
  /** Waits for queued events, before the process exits. */
  flush: () => Promise<void>;
}

/**
 * Starts Sentry for a server app (D-086), or returns a no-op reporter without a DSN (tests, local runs).
 * Errors only: traces go to Grafana through OpenTelemetry, so Sentry doesn't set up its own.
 */
export function initSentry(opts: {
  dsn: string | undefined;
  app: string;
  env: string;
  version: string;
}): ErrorReporter {
  if (!opts.dsn) return { capture: () => undefined, flush: () => Promise.resolve() };
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.env,
    release: opts.version,
    initialScope: { tags: { app: opts.app } },
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
    // scrubEvent only removes fields, so the event keeps Sentry's type.
    beforeSend: (event) => scrubEvent(event as unknown as EventLike) as unknown as typeof event,
  });
  return {
    capture(err, requestId) {
      const ctx = currentContext();
      Sentry.withScope((scope) => {
        if (requestId ?? ctx?.requestId) scope.setTag('request_id', requestId ?? ctx?.requestId);
        if (ctx?.tenantId) scope.setTag('tenant_id', ctx.tenantId);
        if (ctx?.userId) scope.setTag('user_id', ctx.userId);
        if (ctx?.deviceId) scope.setTag('device_id', ctx.deviceId);
        Sentry.captureException(err);
      });
    },
    async flush() {
      await Sentry.flush(2000);
    },
  };
}
