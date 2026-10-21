import { describe, expect, it } from 'vitest';

import { jobs } from './jobs';

describe('job registry', () => {
  it('has unique job names', () => {
    const names = jobs.map((job) => job.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
