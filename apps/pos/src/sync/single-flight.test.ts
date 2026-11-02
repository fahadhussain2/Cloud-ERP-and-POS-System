import { describe, expect, it } from 'vitest';

import { singleFlight } from './single-flight';

// One pull at a time, and none lost (sync spec §8): a nudge that arrives while a pull is running must be followed by
// one more pull, since the running one may already have passed the change (Verify 2 of W1-11 found a cash bill missing
// from the desk's queue for up to 5 minutes).

function controlled() {
  const runs: { resolve: (v: number) => void }[] = [];
  const run = () =>
    new Promise<number>((resolve) => {
      runs.push({ resolve });
    });
  return { runs, run };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('singleFlight', () => {
  it('runs once for one call', async () => {
    const c = controlled();
    const call = singleFlight(c.run);
    const p = call();
    expect(c.runs).toHaveLength(1);
    c.runs[0]!.resolve(1);
    expect(await p).toBe(1);
  });

  it('runs once more after the running one when called meanwhile, and answers with that run', async () => {
    const c = controlled();
    const call = singleFlight(c.run);
    const first = call();
    const second = call();
    expect(c.runs).toHaveLength(1);
    c.runs[0]!.resolve(1);
    expect(await first).toBe(1);
    await tick();
    expect(c.runs).toHaveLength(2);
    c.runs[1]!.resolve(2);
    expect(await second).toBe(2);
  });

  it('folds many calls during a run into one more run', async () => {
    const c = controlled();
    const call = singleFlight(c.run);
    void call();
    const later = [call(), call(), call()];
    c.runs[0]!.resolve(1);
    await tick();
    expect(c.runs).toHaveLength(2);
    c.runs[1]!.resolve(2);
    expect(await Promise.all(later)).toEqual([2, 2, 2]);
    await tick();
    expect(c.runs).toHaveLength(2);
  });

  it('runs again after a failed run, and starts fresh once idle', async () => {
    let n = 0;
    const call = singleFlight(() => (++n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(n)));
    const first = call();
    const second = call();
    await expect(first).rejects.toThrow('offline');
    expect(await second).toBe(2);
    expect(await call()).toBe(3);
  });
});
