import { describe, expect, it } from 'vitest';

import { steps, usage } from './usage';

describe('usage', () => {
  it('lists every pipeline step', () => {
    for (const step of steps) expect(usage()).toContain(step);
  });
});
