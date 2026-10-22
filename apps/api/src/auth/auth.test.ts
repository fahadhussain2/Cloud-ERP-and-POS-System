import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, passwordProblem, verifyPassword } from './password';
import { newToken, parseSessionCookie } from './session';

describe('passwords (D-081)', () => {
  it('hash with Argon2id and the current parameters, and verify', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(needsRehash(h)).toBe(false);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong horse battery')).toBe(false);
  });

  it('never verify against a missing hash or a broken one', async () => {
    expect(await verifyPassword(null, 'anything at all')).toBe(false);
    expect(await verifyPassword('not a hash', 'anything at all')).toBe(false);
  });

  it('flag hashes made with older parameters for an upgrade', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$2b$10$bcryptlookinghash')).toBe(true);
  });

  it('need at least 10 characters, at most 256, and not the username', () => {
    expect(passwordProblem('short', 'ahmed')).toBe('too_short');
    expect(passwordProblem('x'.repeat(257), 'ahmed')).toBe('too_long');
    expect(passwordProblem('Ahmed-is-great-2026', 'ahmed')).toBe('contains_username');
    expect(passwordProblem('correct horse battery', 'ahmed')).toBeNull();
  });
});

describe('session cookie', () => {
  const tenant = '0192f1a0-0000-7000-8000-000000000001';

  it('parses <tenant id>.<token>', () => {
    const token = newToken();
    expect(parseSessionCookie(`${tenant}.${token}`)).toEqual({ tenantId: tenant, token });
  });

  it('rejects anything else', () => {
    const token = newToken();
    for (const v of [
      undefined,
      '',
      token,
      `${tenant}.`,
      `${tenant}.short`,
      `not-a-uuid.${token}`,
      `${tenant}.${token}.x`,
    ]) {
      expect(parseSessionCookie(v), String(v)).toBeNull();
    }
  });
});
