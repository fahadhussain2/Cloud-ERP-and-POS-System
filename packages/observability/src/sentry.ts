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
