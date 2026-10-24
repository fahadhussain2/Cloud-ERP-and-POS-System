import * as Sentry from '@sentry/node';

import { currentContext } from './context';
import { scrubEvent, type EventLike } from './sentry-scrub';

// Sentry for the server apps (D-086).

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
    // Errors only. Our own OpenTelemetry setup traces requests (tracing.ts), so Sentry must not instrument
    // anything: with tracesSampleRate set at all (even 0) it adds its own Fastify integration, which clashes with
    // @fastify/otel and crashed the API at startup (2026-10-24); its module hooks would also run twice.
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
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
