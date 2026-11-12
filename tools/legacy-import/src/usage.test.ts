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
      tenant: 'delux',
      dryRun: false,
    });
    expect(parseArgs(['stage', '--label=oct2026', '--dump', 'copies/2026-10', '--dry-run'])).toEqual({
      step: 'stage',
      label: 'oct2026',
      dump: 'copies/2026-10',
      tenant: 'delux',
      dryRun: true,
    });
  });

  it('loads into the Delux shop unless another is named', () => {
    expect(parseArgs(['load', '--label', 'dec2025', '--tenant', 'demo'])).toMatchObject({
      step: 'load',
      tenant: 'demo',
    });
  });

  it('reads the opening step: the cutoff, the date it posts on, and whether to post (W1-14)', () => {
    expect(
      parseArgs(['opening', '--label', 'final', '--as-of', '2026-12-31', '--date', '2027-01-01', '--post']),
    ).toEqual({
      step: 'opening',
      label: 'final',
      dump: null,
      tenant: 'delux',
      dryRun: false,
      opening: { asOf: '2026-12-31', date: '2027-01-01', post: true },
    });
    expect(parseArgs(['opening', '--label', 'x', '--date', '2027-01-01'])).toEqual({
      error: '--as-of YYYY-MM-DD is required',
    });
    expect(parseArgs(['opening', '--label', 'x', '--as-of', '2026-12-31'])).toEqual({
      error: '--date YYYY-MM-DD is required',
    });
    expect(
      parseArgs([
        'opening',
        '--label',
        'x',
        '--as-of',
        '2026-12-31',
        '--date',
        '2027-01-01',
        '--post',
        '--dry-run',
      ]),
    ).toEqual({ error: '--post and --dry-run exclude each other' });
    expect(parseArgs(['load', '--label', 'x', '--as-of', '2026-12-31'])).toEqual({
      error: '--as-of and --date are for the opening step',
    });
    expect(parseArgs(['load', '--label', 'x', '--post'])).toEqual({ error: 'unknown option --post' });
  });

  it('explains what is wrong', () => {
    expect(parseArgs([])).toEqual({ error: 'which step?' });
    expect(parseArgs(['explode'])).toEqual({ error: 'unknown step explode' });
    expect(parseArgs(['stage'])).toEqual({ error: '--label is required' });
    expect(parseArgs(['stage', '--label'])).toEqual({ error: '--label needs a value' });
    expect(parseArgs(['stage', '--label', 'x', '--loud'])).toEqual({ error: 'unknown option --loud' });
  });
});
