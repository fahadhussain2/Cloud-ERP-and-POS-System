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

const notBuilt = (...args: unknown[]): never => {
  throw new Error(`not built yet (W1-06): ${args.length} arguments`);
};

/**
 * The element pattern of each character, start and stop included: 9 elements per character, bar first, `n` narrow
 * and `w` wide. A narrow space separates the characters.
 */
export function encodeCode39(text: string): string[] {
  return notBuilt(text);
}

/** An SVG image of the barcode, black bars on nothing, sized in the options' units. */
export function code39Svg(text: string, options: Code39Options): string {
  return notBuilt(text, options);
}
