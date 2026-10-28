import { describe, expect, it } from 'vitest';

import cases from '../golden/code39.json';
import { Code39Error, code39Svg, encodeCode39 } from './code39';

// Golden cases as in packages/domain: an input and either the expected patterns or the error code.
describe(cases.description, () => {
  for (const c of cases.cases as { name: string; input: string; expected?: string[]; error?: string }[]) {
    it(c.name, () => {
      if (c.error === undefined) {
        expect(encodeCode39(c.input)).toStrictEqual(c.expected);
        return;
      }
      let thrown: unknown;
      try {
        encodeCode39(c.input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'expected a Code39Error').toBeInstanceOf(Code39Error);
      expect((thrown as Code39Error).code).toBe(c.error);
    });
  }
});

describe('code39Svg', () => {
  const draw = () => code39Svg('A', { narrow: 1, wide: 3, height: 50, quiet: 10 });

  it('draws 5 bars per character, start and stop included', () => {
    expect(draw().match(/<rect /g)).toHaveLength(15);
  });

  it('is as wide as the elements, the gaps and both quiet zones', () => {
    // Each character: 6 narrow + 3 wide = 15; three characters, two gaps, 10 + 10 quiet.
    expect(draw()).toContain('viewBox="0 0 67 50"');
  });

  it('starts the first bar after the quiet zone, with the wide bar of A where it belongs', () => {
    // Start '*' = n w n n w n w n n from x = 10; A begins after its 15 units and a 1-unit gap, with a wide bar.
    expect(draw()).toContain('<rect x="10" y="0" width="1" height="50"/>');
    expect(draw()).toContain('<rect x="26" y="0" width="3" height="50"/>');
  });

  it('refuses what encodeCode39 refuses', () => {
    expect(() => code39Svg('a', { narrow: 1, wide: 3, height: 50, quiet: 10 })).toThrow(Code39Error);
  });
});
