import { describe, expect, it } from 'vitest';

import templateCases from '../golden/label-template.json';
import receiptCases from '../golden/labels-receipt.json';
import {
  DEFAULT_LABEL_TEMPLATE,
  itemLabels,
  labelPages,
  labelTemplateProblems,
  receiptLabels,
  type LabelTemplate,
  type ReceiptLabelsInput,
} from './labels';
import { runGolden, type GoldenFile } from './testing/golden';

// Item labels (W1-17, CAT-08, D-019, D-055): the labels a receipt or a relabel starts with, the template the owner
// saves, and the pages that go to the label printer.

runGolden(receiptCases as unknown as GoldenFile<ReceiptLabelsInput>, receiptLabels);
runGolden(templateCases as unknown as GoldenFile<LabelTemplate>, labelTemplateProblems);

describe('a relabel from the items screen', () => {
  it('starts at one label each, with the supplier given', () => {
    expect(
      itemLabels([
        { itemId: 'i1', code: 'aces0021', name: 'REVERSE CAMERA', supplierAbbr: 'DCEN' },
        { itemId: 'i2', code: 'X#1', name: 'OLD', supplierAbbr: null },
      ]),
    ).toStrictEqual([
      {
        itemId: 'i1',
        code: 'ACES0021',
        name: 'REVERSE CAMERA',
        supplierAbbr: 'DCEN',
        count: 1,
        problems: [],
        warnings: [],
      },
      {
        itemId: 'i2',
        code: 'X#1',
        name: 'OLD',
        supplierAbbr: null,
        count: 1,
        problems: ['code_unprintable'],
        warnings: ['supplier_abbr_missing'],
      },
    ]);
  });
});

describe('the pages sent to the printer', () => {
  const line = (code: string, count: number, problems: 'code_unprintable'[] = []) => ({
    code,
    name: `Item ${code}`,
    supplierAbbr: 'GLST',
    count,
    problems,
  });

  it('one page per label, in the order of the list', () => {
    expect(labelPages([line('A1', 2), line('B2', 1)])).toStrictEqual([
      { code: 'A1', name: 'Item A1', supplierAbbr: 'GLST' },
      { code: 'A1', name: 'Item A1', supplierAbbr: 'GLST' },
      { code: 'B2', name: 'Item B2', supplierAbbr: 'GLST' },
    ]);
  });

  it('leaves out a line with a problem and a count of 0 or less, and counts only whole labels', () => {
    expect(
      labelPages([line('A#1', 3, ['code_unprintable']), line('B2', 0), line('C3', -2), line('D4', 1.7)]),
    ).toStrictEqual([{ code: 'D4', name: 'Item D4', supplierAbbr: 'GLST' }]);
  });
});

describe('the template a shop starts with', () => {
  it('is the 40 × 28 mm roll label, with the name, and no labels on items with the maker’s barcode (CAT-08)', () => {
    expect(DEFAULT_LABEL_TEMPLATE).toStrictEqual({
      widthMm: 40,
      heightMm: 28,
      marginMm: 1,
      shopAbbr: '',
      showName: true,
      labelMakerBarcoded: false,
    });
    expect(labelTemplateProblems(DEFAULT_LABEL_TEMPLATE).problems).toStrictEqual([]);
  });
});
