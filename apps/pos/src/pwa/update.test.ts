import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyUpdateWhenSafe } from './update';

// App updates (POS spec §8): a new version downloads in the background and takes over only when no bill is open.

afterEach(() => vi.useRealTimers());

describe('app updates', () => {
  it('activate at once when no bill is open', () => {
    const activate = vi.fn();
    applyUpdateWhenSafe({ activate, billOpen: () => false });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('wait while a bill is open, then activate once it is closed', () => {
    vi.useFakeTimers();
    let open = true;
    const activate = vi.fn();
    applyUpdateWhenSafe({ activate, billOpen: () => open, retryMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(activate).not.toHaveBeenCalled();
    open = false;
    vi.advanceTimersByTime(1000);
    expect(activate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
