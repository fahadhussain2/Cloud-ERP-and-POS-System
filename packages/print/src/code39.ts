// Code 39 barcodes (POS spec §13, architecture §4.5, D-055): the bill code on printed bills, and later the item
// labels (CAT-08). Drawn as SVG bars, so no barcode font is needed on the counter. Pure, no DOM.

/** The characters Code 39 can carry (without `*`, which is the start and stop character). */
export const CODE39_CHARACTERS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

export type Code39Problem = 'empty' | 'unsupported_character';

export class Code39Error extends Error {
  readonly code: Code39Problem;

  constructor(code: Code39Problem, message: string) {
    super(message);
    this.name = 'Code39Error';
    this.code = code;
  }
}

export interface Code39Options {
  /** Width of a narrow element, in SVG units. */
  narrow: number;
  /** Width of a wide element; 2.5–3 × narrow scans best. */
  wide: number;
  height: number;
  /** Blank margin on each side, in narrow elements (at least 10). */
  quiet: number;
}

/** The patterns of `CODE39_CHARACTERS`, in the same order. */
// prettier-ignore
const PATTERNS = [
  'nnnwwnwnn', 'wnnwnnnnw', 'nnwwnnnnw', 'wnwwnnnnn', 'nnnwwnnnw', 'wnnwwnnnn',
  'nnwwwnnnn', 'nnnwnnwnw', 'wnnwnnwnn', 'nnwwnnwnn', 'wnnnnwnnw', 'nnwnnwnnw',
  'wnwnnwnnn', 'nnnnwwnnw', 'wnnnwwnnn', 'nnwnwwnnn', 'nnnnnwwnw', 'wnnnnwwnn',
  'nnwnnwwnn', 'nnnnwwwnn', 'wnnnnnnww', 'nnwnnnnww', 'wnwnnnnwn', 'nnnnwnnww',
  'wnnnwnnwn', 'nnwnwnnwn', 'nnnnnnwww', 'wnnnnnwwn', 'nnwnnnwwn', 'nnnnwnwwn',
  'wwnnnnnnw', 'nwwnnnnnw', 'wwwnnnnnn', 'nwnnwnnnw', 'wwnnwnnnn', 'nwwnwnnnn',
  'nwnnnnwnw', 'wwnnnnwnn', 'nwwnnnwnn', 'nwnwnwnnn', 'nwnwnnnwn', 'nwnnnwnwn',
  'nnnwnwnwn',
];
const START_STOP = 'nwnnwnwnn';
const PATTERN = new Map([...CODE39_CHARACTERS].map((c, i) => [c, PATTERNS[i]!]));

/**
 * The element pattern of each character, start and stop included: 9 elements per character, bar first, `n` narrow
 * and `w` wide. A narrow space separates the characters.
 */
export function encodeCode39(text: string): string[] {
  if (text === '') throw new Code39Error('empty', 'nothing to encode');
  const patterns = [...text].map((c) => {
    const p = PATTERN.get(c);
    if (p === undefined) throw new Code39Error('unsupported_character', `Code 39 can't carry "${c}"`);
    return p;
  });
  return [START_STOP, ...patterns, START_STOP];
}

// Rounded so fractional widths don't print as 0.30000000000000004.
const unit = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The width of `code39Svg`'s drawing, in the options' units: the elements, a narrow gap between characters and the
 * two quiet zones. The text printed under the bars uses it to line up with them.
 */
export function code39Width(text: string, options: Code39Options): number {
  const { narrow, wide, quiet } = options;
  const patterns = encodeCode39(text);
  const elements = patterns.reduce(
    (sum, p) => sum + [...p].reduce((w, e) => w + (e === 'w' ? wide : narrow), 0),
    0,
  );
  return Number(unit(elements + (patterns.length - 1) * narrow + 2 * quiet * narrow));
}

/** An SVG image of the barcode, black bars on nothing, sized in the options' units. */
export function code39Svg(text: string, options: Code39Options): string {
  const { narrow, wide, height, quiet } = options;
  const bars: string[] = [];
  let x = quiet * narrow;
  encodeCode39(text).forEach((pattern, i) => {
    if (i > 0) x += narrow;
    [...pattern].forEach((element, j) => {
      const width = element === 'w' ? wide : narrow;
      if (j % 2 === 0)
        bars.push(`<rect x="${unit(x)}" y="0" width="${unit(width)}" height="${unit(height)}"/>`);
      x += width;
    });
  });
  const total = x + quiet * narrow;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${unit(total)} ${unit(height)}" ` +
    `preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${bars.join('')}</svg>`
  );
}
