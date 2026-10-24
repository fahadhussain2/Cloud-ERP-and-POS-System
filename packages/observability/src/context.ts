import { AsyncLocalStorage } from 'node:async_hooks';

// The request context every log line and error carries (architecture §11.2, D-086). Set once where it's known
// (request start, auth), read by the logger; no call site passes IDs around.

export interface LogContext {
  requestId?: string;
  traceId?: string;
  tenantId?: string;
  branchId?: string;
  userId?: string;
  deviceId?: string;
}

const store = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with `ctx` as the context (a copy, so concurrent work never shares one). */
export const withContext = <T>(ctx: LogContext, fn: () => T): T => store.run({ ...ctx }, fn);

/** Adds to the current context, e.g. the tenant and user once a request is authenticated. No-op outside one. */
export function setContext(patch: LogContext): void {
  const current = store.getStore();
  if (current) Object.assign(current, patch);
}

/** Starts a context for the rest of the current async flow (a request's hooks and handler). */
export const enterContext = (ctx: LogContext): void => store.enterWith({ ...ctx });

export const currentContext = (): Readonly<LogContext> | undefined => store.getStore();
