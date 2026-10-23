import { describe, expect, it } from 'vitest';

import { parseArgs, steps, usage } from './usage';

describe('usage', () => {
  it('lists every pipeline step', () => {
    for (const step of steps) expect(usage()).toContain(step);
  });
});

describe('arguments', () => {
  it('reads the step, the label and an optional dump folder', () => {
    expect(parseArgs(['stage', '--label', 'dec2025'])).toEqual({
      step: 'stage',
      label: 'dec2025',
      dump: null,
      dryRun: false,
    });
    expect(parseArgs(['stage', '--label=oct2026', '--dump', 'copies/2026-10', '--dry-run'])).toEqual({
      step: 'stage',
      label: 'oct2026',
      dump: 'copies/2026-10',
      dryRun: true,
    });
  });

  it('explains what is wrong', () => {
    expect(parseArgs([])).toEqual({ error: 'which step?' });
    expect(parseArgs(['explode'])).toEqual({ error: 'unknown step explode' });
    expect(parseArgs(['stage'])).toEqual({ error: '--label is required' });
    expect(parseArgs(['stage', '--label'])).toEqual({ error: '--label needs a value' });
    expect(parseArgs(['stage', '--label', 'x', '--loud'])).toEqual({ error: 'unknown option --loud' });
  });
});
