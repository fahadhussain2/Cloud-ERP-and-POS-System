import type { Code39Options } from '@erp/print';

// The page a bill or a desk slip prints on (W2-19, owner's scan test 2026-11-28). Rendered with the print, so it
// exists only while printing and never touches the counter's screens.
//
// - The paper size comes from the print profile (D-048, D-055).
// - The 8 mm margin is inside each page, not asked of the print dialog: with its Margins set to None the browser
//   dropped `@page`'s margin and the bill ran to the paper's edges. Repeated on every page of a long bill.
// - A white page with black ink in both themes: the counter's own page background (grey, or near-black in the dark
//   theme) printed whenever Background graphics was ticked.

export function pageStyle(page: 'a5' | 'a4'): string {
  return (
    `@page { size: ${page === 'a5' ? 'A5 landscape' : 'A4 portrait'}; margin: 0; } ` +
    '.bill-page { box-sizing: border-box; padding: 8mm; -webkit-box-decoration-break: clone; ' +
    'box-decoration-break: clone; } ' +
    '@media print { html, body { background: #fff !important; color: #000 !important; } }'
  );
}

/**
 * The bill code's bars at their real size (W2-19): the narrowest 1/75 inch (0.339 mm), which lands on whole dots at
 * 300 and 600 dpi, the wide ones 2.5 times that, 11 mm tall, a quiet zone of 10 narrow bars on each side. The
 * barcode is as wide as its code needs (about 95 mm for a 4-digit cash due) instead of squeezed into 62 mm, where
 * its bars were 0.2 mm and the scanner couldn't read them.
 */
export const BILL_BARS: Code39Options = {
  narrow: 25.4 / 75,
  wide: (2.5 * 25.4) / 75,
  height: 11,
  quiet: 10,
  mm: true,
};
