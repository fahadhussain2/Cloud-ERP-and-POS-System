import { describe, expect, it } from 'vitest';

import { DEFAULT_THRESHOLDS, offlineLevel } from './offline';

// Offline warnings (SYN-06, POS spec §7, owner answer 1 to W1-07): from the last successful sync, never blocking.

const CONTACT = '2026-11-02T10:00:00.000Z';
const H = 3_600_000;
const at = (hours: number) => Date.parse(CONTACT) + hours * H;

describe('offlineLevel', () => {
  it('warns after 8 hours and strongly after 48 by default', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ warningHours: 8, strongHours: 48 });
    expect(offlineLevel(CONTACT, at(0), DEFAULT_THRESHOLDS)).toBe('none');
    expect(offlineLevel(CONTACT, at(8) - 1, DEFAULT_THRESHOLDS)).toBe('none');
    expect(offlineLevel(CONTACT, at(8), DEFAULT_THRESHOLDS)).toBe('warning');
    expect(offlineLevel(CONTACT, at(48) - 1, DEFAULT_THRESHOLDS)).toBe('warning');
    expect(offlineLevel(CONTACT, at(48), DEFAULT_THRESHOLDS)).toBe('strong');
    expect(offlineLevel(CONTACT, at(24 * 30), DEFAULT_THRESHOLDS)).toBe('strong');
  });

  it("uses the tenant's own thresholds", () => {
    const t = { warningHours: 2, strongHours: 4 };
    expect(offlineLevel(CONTACT, at(2) - 1, t)).toBe('none');
    expect(offlineLevel(CONTACT, at(2), t)).toBe('warning');
    expect(offlineLevel(CONTACT, at(4), t)).toBe('strong');
  });

  it('says nothing before the first contact, or with a clock behind the last contact', () => {
    expect(offlineLevel(null, at(100), DEFAULT_THRESHOLDS)).toBe('none');
    expect(offlineLevel(CONTACT, at(-50), DEFAULT_THRESHOLDS)).toBe('none');
  });
});
