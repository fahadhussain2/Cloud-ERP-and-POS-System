import { z } from 'zod';

// The shop's name and bill header, set by the owner (W1-25 plan; PLT-01, POS-09, D-112): the shop name
// (`tenants.name`), the branch's address, phone and extra lines (`branches.address`, `phone`,
// `receipt_header.lines`), and the policy line (the default print profile's `template_options.policyText`).

/** One printed line fits the A5 landscape bill (owner answer 2). */
export const SHOP_LINE_MAX = 60;
/** Extra header lines after the address and phone (owner answer 2). */
export const SHOP_EXTRA_LINES_MAX = 3;

const line = z.string().trim().max(SHOP_LINE_MAX);

/** What the owner saves. Blank values clear the field: no address, no phone, no extra line, the default policy. */
export const ShopSettingsRequest = z.strictObject({
  name: line.min(1),
  branchId: z.uuid(),
  address: line,
  phone: line,
  lines: z.array(line).max(SHOP_EXTRA_LINES_MAX),
  policyText: line,
});
export type ShopSettingsRequest = z.infer<typeof ShopSettingsRequest>;

export interface ShopSettingsView {
  name: string;
  branchId: string;
  /** The branch's own name, for the screen's heading (not printed). */
  branchName: string;
  address: string;
  phone: string;
  lines: string[];
  /** Empty: the bill prints the default policy line. */
  policyText: string;
  /** The default print profile's own header lines, printed after the branch's (shown in the preview, not edited). */
  profileLines: string[];
}
