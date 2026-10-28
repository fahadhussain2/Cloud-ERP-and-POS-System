// @vitest-environment node
import { verifyCanonical } from '@erp/contracts';
import { describe, expect, it } from 'vitest';

import type { Api, ApiResponse } from '../net/api';
import { OfflineError } from '../net/api';
import type { DeviceInfo } from '../db/repo';
import { createTokenSource, enroll, type KeyStore } from './session';

// The counter side of enrollment and device tokens (POS spec §4, platform spec §1-§3, D-082).

const TENANT = '0190a0b0-0000-7000-8000-000000000001';
const DEVICE = '0190a0b0-0000-7000-8000-000000000002';
const BRANCH = '0190a0b0-0000-7000-8000-000000000003';

const memoryKeys = (): KeyStore & { pair: CryptoKeyPair | null } => {
  const s = {
    pair: null as CryptoKeyPair | null,
    get: () => Promise.resolve(s.pair),
    put: (p: CryptoKeyPair) => {
      s.pair = p;
      return Promise.resolve();
    },
  };
  return s;
};

describe('enroll', () => {
  it('registers a new key, proves it holds it, and keeps the key and the device', async () => {
    const keys = memoryKeys();
    let saved: DeviceInfo | null = null;
    const api: Api = async (method, path, opts) => {
      expect([method, path]).toEqual(['POST', '/api/devices/enroll']);
      const b = opts?.body as { tenantCode: string; code: string; publicKey: string; signature: string };
      // What the server checks: the signature over the normalized fields, with the key being registered.
      expect(b.code).toBe('K7Q2-M9XD');
      expect(b.tenantCode).toBe('delux');
      expect(
        await verifyCanonical(
          b.publicKey,
          { tenantCode: b.tenantCode, code: b.code, publicKey: b.publicKey },
          b.signature,
        ),
      ).toBe(true);
      return {
        status: 201,
        body: { deviceId: DEVICE, tenantId: TENANT, branchId: BRANCH, code: 'C1', kind: 'counter' },
      };
    };
    const r = await enroll(
      { tenantCode: ' Delux ', code: 'k7q2 m9xd' },
      { api, keys, setDevice: (d) => void (saved = d) },
    );
    expect(r).toEqual({ ok: true });
    expect(keys.pair?.privateKey.extractable).toBe(false);
    expect(saved).toEqual({
      deviceId: DEVICE,
      tenantId: TENANT,
      branchId: BRANCH,
      code: 'C1',
      kind: 'counter',
    });
  });

  it('keeps nothing when the server refuses or cannot be reached', async () => {
    for (const [reply, error] of [
      [{ status: 400, body: { error: 'enrollment_failed' } }, 'enrollment_failed'],
      [{ status: 429, body: { error: 'too_many_attempts' } }, 'too_many_attempts'],
      [new OfflineError(), 'offline'],
    ] as const) {
      const keys = memoryKeys();
      let saved = false;
      const api: Api = () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply));
      expect(
        await enroll(
          { tenantCode: 'delux', code: 'K7Q2M9XD' },
          { api, keys, setDevice: () => void (saved = true) },
        ),
      ).toEqual({ ok: false, error });
      expect(keys.pair).toBeNull();
      expect(saved).toBe(false);
    }
  });
});

describe('device token', () => {
  const device: DeviceInfo = {
    deviceId: DEVICE,
    tenantId: TENANT,
    branchId: BRANCH,
    code: 'C1',
    kind: 'counter',
  };

  const server = (keys: { pair: CryptoKeyPair | null }, tokenStatus = 200) => {
    const calls: string[] = [];
    let n = 0;
    const api: Api = async (_method, path, opts): Promise<ApiResponse> => {
      calls.push(path);
      if (path === '/api/devices/challenge') return { status: 200, body: { nonce: `nonce${++n}` } };
      const b = opts?.body as { tenantId: string; deviceId: string; nonce: string; signature: string };
      const { exportPublicKey } = await import('@erp/contracts');
      const spki = await exportPublicKey(keys.pair!.publicKey);
      expect(
        await verifyCanonical(
          spki,
          { tenantId: b.tenantId, deviceId: b.deviceId, nonce: b.nonce },
          b.signature,
        ),
      ).toBe(true);
      if (tokenStatus !== 200) return { status: tokenStatus, body: { error: 'device_refused' } };
      return {
        status: 200,
        body: { accessToken: `${TENANT}.t${n}`, expiresAt: new Date(clock + 3_600_000).toISOString() },
      };
    };
    return { api, calls };
  };
  let clock = Date.parse('2026-10-25T10:00:00Z');

  it('signs a fresh challenge, then reuses the token until shortly before it expires', async () => {
    const { generateDeviceKey } = await import('@erp/contracts');
    const keys = memoryKeys();
    await keys.put(await generateDeviceKey());
    const { api, calls } = server(keys);
    const tokens = createTokenSource({ api, keys, device: () => Promise.resolve(device), now: () => clock });
    expect(await tokens.get()).toBe(`${TENANT}.t1`);
    expect(await tokens.get()).toBe(`${TENANT}.t1`);
    expect(calls).toHaveLength(2);
    clock += 3_600_000 - 30_000; // within the last minute
    expect(await tokens.get()).toBe(`${TENANT}.t2`);
    tokens.invalidate();
    expect(await tokens.get()).toBe(`${TENANT}.t3`);
  });

  it('reports a revoked device', async () => {
    const { generateDeviceKey } = await import('@erp/contracts');
    const keys = memoryKeys();
    await keys.put(await generateDeviceKey());
    const { api } = server(keys, 401);
    const tokens = createTokenSource({ api, keys, device: () => Promise.resolve(device), now: () => clock });
    await expect(tokens.get()).rejects.toMatchObject({ name: 'DeviceRefusedError', revoked: false });
  });

  it('says when the refusal is because the counter was revoked (W1-07, sync spec §1)', async () => {
    const { generateDeviceKey } = await import('@erp/contracts');
    const keys = memoryKeys();
    await keys.put(await generateDeviceKey());
    const api: Api = (_m, path) =>
      Promise.resolve(
        path === '/api/devices/challenge'
          ? { status: 401, body: { error: 'device_revoked' } }
          : { status: 500, body: null },
      );
    const tokens = createTokenSource({ api, keys, device: () => Promise.resolve(device), now: () => clock });
    await expect(tokens.get()).rejects.toMatchObject({ name: 'DeviceRefusedError', revoked: true });
  });
});
