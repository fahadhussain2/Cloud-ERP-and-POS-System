import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical';
import {
  exportPublicKey,
  fromBase64Url,
  generateDeviceKey,
  makePinVerifier,
  parsePinVerifier,
  PIN_ITERATIONS,
  signCanonical,
  verifyCanonical,
  verifyPin,
} from './device-crypto';

// The device crypto shared by the POS (browser) and the API (Node), both on WebCrypto (spec §2-§4, D-082).

describe('canonicalJson', () => {
  it('gives the same text whatever the key order, with no spaces', () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'é' } });
    const b = canonicalJson({ a: { c: 'é', d: [3, { x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"é","d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it('drops undefined properties like JSON does, and keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('refuses values JSON cannot represent exactly', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, Symbol('s')]) {
      expect(() => canonicalJson({ v }), String(v)).toThrow();
    }
    expect(() => canonicalJson(undefined)).toThrow();
  });
});

describe('device signatures', () => {
  it('verify what the device signed, and nothing else', async () => {
    const keys = await generateDeviceKey();
    const publicKey = await exportPublicKey(keys.publicKey);
    const doc = { id: '0192f1a0-0000-7000-8000-000000000001', total: 125000 };
    const sig = await signCanonical(keys.privateKey, doc);

    expect(await verifyCanonical(publicKey, { total: 125000, id: doc.id }, sig)).toBe(true);
    expect(await verifyCanonical(publicKey, { ...doc, total: 125001 }, sig)).toBe(false);

    const other = await exportPublicKey((await generateDeviceKey()).publicKey);
    expect(await verifyCanonical(other, doc, sig)).toBe(false);
  });

  it('use IEEE P1363 signatures (64 bytes), as WebCrypto makes them', async () => {
    const keys = await generateDeviceKey();
    const sig = await signCanonical(keys.privateKey, { a: 1 });
    expect(fromBase64Url(sig)).toHaveLength(64);
  });

  it('treat a broken key or signature as "not verified", never as an error', async () => {
    const keys = await generateDeviceKey();
    const publicKey = await exportPublicKey(keys.publicKey);
    const sig = await signCanonical(keys.privateKey, { a: 1 });
    expect(await verifyCanonical('not-a-key', { a: 1 }, sig)).toBe(false);
    expect(await verifyCanonical(publicKey, { a: 1 }, 'AAAA')).toBe(false);
  });

  it('keep the private key inside the browser: it cannot be exported', async () => {
    const keys = await generateDeviceKey();
    await expect(crypto.subtle.exportKey('pkcs8', keys.privateKey)).rejects.toThrow();
  });
});

describe('PIN verifiers', () => {
  it('use PBKDF2-SHA256 with 600,000 iterations by default and never contain the PIN', async () => {
    const v = await makePinVerifier('4821');
    expect(v).toMatch(/^pbkdf2-sha256\$600000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(v).not.toContain('4821');
    expect(parsePinVerifier(v)?.iterations).toBe(PIN_ITERATIONS);
    expect(await verifyPin(v, '4821')).toBe(true);
    expect(await verifyPin(v, '4822')).toBe(false);
  });

  it('salt every verifier, so the same PIN gives different strings', async () => {
    const [a, b] = await Promise.all([makePinVerifier('4821', 1000), makePinVerifier('4821', 1000)]);
    expect(a).not.toBe(b);
    expect(await verifyPin(a, '4821')).toBe(true);
  });

  it('refuse anything that is not a verifier', async () => {
    for (const v of ['', 'plain', 'pbkdf2-sha256$abc$x$y', '$argon2id$v=19$m=19456,t=2,p=1$x$y']) {
      expect(parsePinVerifier(v), v).toBeNull();
      expect(await verifyPin(v, '4821')).toBe(false);
    }
  });
});
