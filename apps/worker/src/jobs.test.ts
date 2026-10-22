import { afterEach, describe, expect, it, vi } from 'vitest';

import { jobs, startWorker } from './jobs';

describe('job registry', () => {
  it('has unique job names', () => {
    const names = jobs.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('startWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the process alive until stopped', async () => {
    vi.useFakeTimers();
    const stop = startWorker();
    expect(vi.getTimerCount()).toBe(1);

    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
