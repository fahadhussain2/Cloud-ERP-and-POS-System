import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jobsFor, startWorker } from './jobs';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('job registry', () => {
  it('has unique job names, and the posting catch-up when there is a database', () => {
    const names = jobsFor({ pool: {} as pg.Pool, log }).map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('posting-catch-up');
  });

  it('has no database jobs without a database', () => {
    expect(jobsFor({ pool: undefined, log })).toEqual([]);
  });
});

describe('startWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the process alive until stopped', async () => {
    vi.useFakeTimers();
    const stop = startWorker([], () => undefined);
    expect(vi.getTimerCount()).toBe(1);

    await stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs a job at start-up and again after its interval, and stops it', async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.resolve());
    const stop = startWorker([{ name: 'tick', everyMs: 60_000, run }], () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);

    await stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failing run and tries again at the next turn', async () => {
    vi.useFakeTimers();
    const boom = new Error('database down');
    const run = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined);
    const errors: [string, unknown][] = [];
    const stop = startWorker([{ name: 'flaky', everyMs: 1000, run }], (job, err) =>
      errors.push([job.name, err]),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual([['flaky', boom]]);
    expect(run).toHaveBeenCalledTimes(2);
    await stop();
  });
});
