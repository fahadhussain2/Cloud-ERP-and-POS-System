// Item labels (W1-17, CAT-08, D-019, D-055): the labels a posted goods receipt or a relabel starts with, the label
// template the owner saves, and the pages sent to the label printer. Pure; quantities in thousandths (rule 1).

/** What Code 39 carries (D-055), without `*`, its start and stop character. */
const CODE39 = /^[0-9A-Z\-. $/+%]+$/;

/** One label on a roll (owner answer 1: the Zebra roll, no A4 sheets), laid out as the legacy label (owner answer 3). */
export interface LabelTemplate {
  widthMm: number;
  heightMm: number;
  /** Blank edge on every side. */
  marginMm: number;
  /** Printed top left, e.g. DCAC (Delux City Auto Corner); empty = none. */
  shopAbbr: string;
  /** The item name on one line at the bottom. */
  showName: boolean;
  /** Items that carry the maker's barcode get labels too (Delux: yes, owner answer 4); otherwise they start at 0. */
  labelMakerBarcoded: boolean;
}

/** A shop's template until the owner saves one: the legacy 40 × 28 mm label, and CAT-08's maker's-barcode rule. */
export const DEFAULT_LABEL_TEMPLATE: LabelTemplate = {
  widthMm: 40,
  heightMm: 28,
  marginMm: 1,
  shopAbbr: '',
  showName: true,
  labelMakerBarcoded: false,
};

export type LabelTemplateProblem =
  'width_out_of_range' | 'height_out_of_range' | 'margin_out_of_range' | 'shop_abbr_too_long';

/** The Zebra GX420t prints up to 104 mm across. */
const WIDTH = [20, 104] as const;
const HEIGHT = [10, 200] as const;
const MARGIN_MAX = 5;
/** What a margin must leave of the label, each way. */
const INSIDE_MIN = 10;
const SHOP_ABBR_MAX = 10;

/** The template as it is saved (the shop's abbreviation trimmed and upper case), and its problems in a fixed order. */
export function labelTemplateProblems(input: LabelTemplate): {
  template: LabelTemplate;
  problems: LabelTemplateProblem[];
} {
  const template = { ...input, shopAbbr: input.shopAbbr.trim().toUpperCase() };
  const { widthMm, heightMm, marginMm } = template;
  const problems: LabelTemplateProblem[] = [];
  if (widthMm < WIDTH[0] || widthMm > WIDTH[1]) problems.push('width_out_of_range');
  if (heightMm < HEIGHT[0] || heightMm > HEIGHT[1]) problems.push('height_out_of_range');
  if (
    marginMm < 0 ||
    marginMm > MARGIN_MAX ||
    widthMm - 2 * marginMm < INSIDE_MIN ||
    heightMm - 2 * marginMm < INSIDE_MIN
  )
    problems.push('margin_out_of_range');
  if (template.shopAbbr.length > SHOP_ABBR_MAX) problems.push('shop_abbr_too_long');
  return { template, problems };
}

/** A line that can't print (left off the labels). */
export type LabelProblem = 'code_unprintable';
/** A line that prints, but not quite as it should. */
export type LabelWarning = 'supplier_abbr_missing';

export interface LabelLine {
  itemId: string;
  /** Upper case, as on the barcode. */
  code: string;
  name: string;
  /** Upper case; null = none. */
  supplierAbbr: string | null;
  count: number;
  problems: LabelProblem[];
  warnings: LabelWarning[];
}

export interface LabelItem {
  itemId: string;
  code: string;
  name: string;
  supplierAbbr: string | null;
}

export interface ReceiptLabelSource extends LabelItem {
  /** Thousandths. */
  qty: number;
  allowsFraction: boolean;
  /** The item has a barcode other than its own code: the maker's, on its box. */
  makerBarcode: boolean;
}

export interface ReceiptLabelsInput {
  labelMakerBarcoded: boolean;
  lines: ReceiptLabelSource[];
}

function labelLine(item: LabelItem, count: number): LabelLine {
  const code = item.code.trim().toUpperCase();
  const abbr = item.supplierAbbr?.trim().toUpperCase() ?? '';
  return {
    itemId: item.itemId,
    code,
    name: item.name,
    supplierAbbr: abbr === '' ? null : abbr,
    count,
    problems: CODE39.test(code) ? [] : ['code_unprintable'],
    warnings: abbr === '' ? ['supplier_abbr_missing'] : [],
  };
}

/**
 * A posted receipt's labels (CAT-08): one per piece received, one per line for an item sold in fractions (a litre of
 * oil is one container), 0 for an item with the maker's barcode unless the shop labels those too.
 */
export function receiptLabels(input: ReceiptLabelsInput): LabelLine[] {
  return input.lines.map((l) => {
    const count =
      l.makerBarcode && !input.labelMakerBarcoded
        ? 0
        : l.allowsFraction
          ? 1
          : Math.max(0, Math.floor(l.qty / 1000));
    return labelLine(l, count);
  });
}

/** A relabel of items picked on the items screen: one label each. */
export function itemLabels(items: LabelItem[]): LabelLine[] {
  return items.map((i) => labelLine(i, 1));
}

export interface LabelPage {
  code: string;
  name: string;
  supplierAbbr: string | null;
}

/** The pages sent to the printer: one per label, in the order of the list; lines with a problem are left out. */
export function labelPages(
  lines: readonly Pick<LabelLine, 'code' | 'name' | 'supplierAbbr' | 'count' | 'problems'>[],
): LabelPage[] {
  return lines.flatMap((l) =>
    l.problems.length > 0
      ? []
      : Array.from({ length: Math.max(0, Math.floor(l.count)) }, () => ({
          code: l.code,
          name: l.name,
          supplierAbbr: l.supplierAbbr,
        })),
  );
}
