import { createHash, randomBytes } from 'node:crypto';

// Back-office sessions (D-081). The cookie is `<tenant id>.<token>`; only the token's SHA-256 is stored.

export const SESSION_COOKIE = 'erp_session';
export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
export const SESSION_IDLE_MS = 2 * 3600_000;
/** last_seen_at is written at most this often, not on every request. */
export const SESSION_TOUCH_MS = 5 * 60_000;
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function parseSessionCookie(value: string | undefined): { tenantId: string; token: string } | null {
  if (!value) return null;
  const [tenantId, token, ...rest] = value.split('.');
  if (rest.length > 0 || !tenantId || !token || !UUID.test(tenantId) || !TOKEN.test(token)) return null;
  return { tenantId, token };
}
