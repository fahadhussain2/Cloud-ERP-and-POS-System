import type { CounterPinChangeRequest } from '@erp/contracts';

import { DeviceRefusedError, type TokenSource } from '../device/session';
import { OfflineError, type Api } from '../net/api';

// Choosing your own PIN at the counter (sync spec §5, owner answer 2 to W1-02). Needs the internet, so that every
// counter learns the new PIN at its next pull.

export type PinChangeResult = 'ok' | 'weak_pin' | 'wrong_pin' | 'pin_locked' | 'offline' | 'failed';

export async function changePin(
  deps: { api: Api; tokens: TokenSource },
  body: CounterPinChangeRequest,
): Promise<PinChangeResult> {
  let res;
  try {
    res = await deps.api('POST', '/api/sync/pin', { body, token: await deps.tokens.get() });
  } catch (err) {
    if (err instanceof OfflineError) return 'offline';
    if (err instanceof DeviceRefusedError) return 'failed';
    throw err;
  }
  if (res.status === 204) return 'ok';
  const error = (res.body as { error?: string } | null)?.error;
  if (error === 'weak_pin' || error === 'wrong_pin' || error === 'pin_locked') return error;
  if (res.status === 401) deps.tokens.invalidate();
  return 'failed';
}
