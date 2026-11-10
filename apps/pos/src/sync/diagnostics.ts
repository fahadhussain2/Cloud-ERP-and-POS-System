import type { DiagnosticsUpload } from '@erp/contracts';

import { DeviceRefusedError, type TokenSource } from '../device/session';
import { OfflineError, type Api } from '../net/api';

// Send diagnostics (PLT-12, owner answer 6 to W1-20, D-110): a manager, after their PIN, sends this counter's last
// 5,000 log events and its health to support. Nothing personal or secret leaves the counter: a key that names a phone,
// a PIN, a password or a token is dropped at any depth before sending. The server checks the manager again.

export type DiagnosticsResult = 'sent' | 'offline' | 'not_permitted' | 'failed';

const SECRET = /phone|pin|password|token|secret|signature/i;

/** A log detail without personal data or secrets. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !SECRET.test(k))
      .map(([k, v]) => [k, scrub(v)]),
  );
}

const parse = (detail: string): unknown => {
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return detail;
  }
};

export async function sendDiagnostics(
  deps: {
    api: Api;
    tokens: TokenSource;
    /** The log as stored, oldest first; `detail` is its JSON text. */
    log: () => Promise<{ at: string; kind: string; detail: string }[]>;
    health: () => Promise<object>;
    now?: () => Date;
  },
  sentByUserId: string,
): Promise<DiagnosticsResult> {
  const [events, health] = await Promise.all([deps.log(), deps.health()]);
  const body: DiagnosticsUpload = {
    sentByUserId,
    atDevice: (deps.now?.() ?? new Date()).toISOString(),
    health: scrub(health) as Record<string, unknown>,
    events: events.map((e) => ({ at: e.at, kind: e.kind, detail: scrub(parse(e.detail)) })),
  };
  let res;
  try {
    res = await deps.api('POST', '/api/sync/diagnostics', { body, token: await deps.tokens.get() });
  } catch (err) {
    if (err instanceof OfflineError) return 'offline';
    if (err instanceof DeviceRefusedError) return 'failed';
    throw err;
  }
  if (res.status === 201) return 'sent';
  if (res.status === 403) return 'not_permitted';
  if (res.status === 401) deps.tokens.invalidate();
  return 'failed';
}
