import { exportPublicKey, generateDeviceKey, normalizeEnrollmentCode, signCanonical } from '@erp/contracts';

import type { DeviceInfo } from '../db/repo';
import { OfflineError, type Api } from '../net/api';

// The counter side of enrollment and device tokens (POS spec §4, platform spec §1-§3, D-082).

/** Where the counter keeps its key pair: IndexedDB in the browser (keys.ts). */
export interface KeyStore {
  get(): Promise<CryptoKeyPair | null>;
  put(pair: CryptoKeyPair): Promise<void>;
}

export type EnrollResult =
  { ok: true } | { ok: false; error: 'enrollment_failed' | 'too_many_attempts' | 'offline' };

interface EnrollDeps {
  api: Api;
  keys: KeyStore;
  setDevice: (d: DeviceInfo) => unknown;
}

/** Enrolls this counter with a manager's one-time code. Nothing is kept unless the server accepts it. */
export async function enroll(
  input: { tenantCode: string; code: string },
  deps: EnrollDeps,
): Promise<EnrollResult> {
  // The same normalization as the server, which checks the signature over the normalized values.
  const tenantCode = input.tenantCode.trim().toLowerCase();
  const code = normalizeEnrollmentCode(input.code.trim());
  const pair = await generateDeviceKey();
  const publicKey = await exportPublicKey(pair.publicKey);
  const signature = await signCanonical(pair.privateKey, { tenantCode, code, publicKey });
  let res;
  try {
    res = await deps.api('POST', '/api/devices/enroll', { body: { tenantCode, code, publicKey, signature } });
  } catch (err) {
    if (err instanceof OfflineError) return { ok: false, error: 'offline' };
    throw err;
  }
  if (res.status === 429) return { ok: false, error: 'too_many_attempts' };
  if (res.status !== 201) return { ok: false, error: 'enrollment_failed' };
  const b = res.body as { deviceId: string; tenantId: string; branchId: string; code: string; kind: string };
  await deps.keys.put(pair);
  await deps.setDevice({
    deviceId: b.deviceId,
    tenantId: b.tenantId,
    branchId: b.branchId,
    code: b.code,
    kind: b.kind,
  });
  return { ok: true };
}

export class DeviceRefusedError extends Error {
  override name = 'DeviceRefusedError';
}

export interface TokenSource {
  /** A valid device token, fetched with a signed challenge when there is none or it is about to expire. */
  get(): Promise<string>;
  /** Forget the token (the server refused it). */
  invalidate(): void;
}

/** A token is renewed this long before it expires. */
const RENEW_MS = 60_000;

export function createTokenSource(deps: {
  api: Api;
  keys: KeyStore;
  device: () => Promise<DeviceInfo | null>;
  now?: () => number;
}): TokenSource {
  const now = deps.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  return {
    async get() {
      if (cached && cached.expiresAt - RENEW_MS > now()) return cached.token;
      const [device, pair] = await Promise.all([deps.device(), deps.keys.get()]);
      if (!device || !pair) throw new DeviceRefusedError('this counter is not enrolled');
      const { tenantId, deviceId } = device;
      const ch = await deps.api('POST', '/api/devices/challenge', { body: { tenantId, deviceId } });
      if (ch.status !== 200) throw new DeviceRefusedError('challenge refused');
      const { nonce } = ch.body as { nonce: string };
      const signature = await signCanonical(pair.privateKey, { tenantId, deviceId, nonce });
      const t = await deps.api('POST', '/api/devices/token', {
        body: { tenantId, deviceId, nonce, signature },
      });
      if (t.status !== 200) throw new DeviceRefusedError('token refused');
      const b = t.body as { accessToken: string; expiresAt: string };
      cached = { token: b.accessToken, expiresAt: Date.parse(b.expiresAt) };
      return cached.token;
    },
    invalidate() {
      cached = null;
    },
  };
}
