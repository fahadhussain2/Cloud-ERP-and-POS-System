import { z } from 'zod';

// Item labels (W1-17 plan; CAT-08, D-019, D-055): the label template the owner saves, a relabel of items, and the
// label lines a posted receipt or a relabel starts with. The rules are in @erp/domain (labels.ts).

/** The template as sent; the ranges are checked by `labelTemplateProblems`, so the owner sees every problem at once. */
export const LabelTemplateRequest = z.strictObject({
  widthMm: z.number(),
  heightMm: z.number(),
  marginMm: z.number(),
  shopAbbr: z.string().max(40),
  showName: z.boolean(),
  labelMakerBarcoded: z.boolean(),
});
export type LabelTemplateRequest = z.infer<typeof LabelTemplateRequest>;

export const LabelItemsRequest = z.strictObject({
  itemIds: z.array(z.uuid()).min(1).max(200),
});
export type LabelItemsRequest = z.infer<typeof LabelItemsRequest>;

export interface LabelLineView {
  itemId: string;
  code: string;
  name: string;
  supplierAbbr: string | null;
  count: number;
  problems: 'code_unprintable'[];
  warnings: 'supplier_abbr_missing'[];
}

export interface LabelsView {
  /** The posted receipt the labels come from; null for a relabel of items. */
  source: { number: string; supplier: string } | null;
  template: LabelTemplateRequest;
  lines: LabelLineView[];
}
