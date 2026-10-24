import { describe, expect, it } from 'vitest';

import { isRequestId, newRequestId } from './request-id';

// Request IDs (architecture §11.2): UUIDv7, so they sort by time; a caller's ID is kept only if it is one.
describe('request IDs', () => {
  it('are UUIDv7 and increase with time', async () => {
    const a = newRequestId();
    await new Promise((r) => setTimeout(r, 2));
    const b = newRequestId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isRequestId(a)).toBe(true);
    expect(b > a).toBe(true);
  });

  it('accept only UUIDs, nothing that could inject into logs', () => {
    expect(isRequestId('0192f1a0-0000-7000-8000-00000000e2e0')).toBe(true);
    expect(isRequestId('not-a-uuid')).toBe(false);
    expect(isRequestId('0192f1a0-0000-7000-8000-00000000e2e0\nfake log line')).toBe(false);
    expect(isRequestId(undefined)).toBe(false);
  });
});
