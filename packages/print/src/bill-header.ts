// The header under the shop name on the bill and the desk slip (POS spec §13, W1-25): the branch's address, phone
// and extra lines (`branches.receipt_header.lines`), then the print profile's own `headerLines`. One rule for the
// counter, the cash desk and the back office's preview, so the preview prints what the bill prints.

export interface BillHeaderSource {
  address: string | null;
  phone: string | null;
  lines: readonly string[];
  profileLines: readonly string[];
}

/** The header lines in print order, each trimmed, blank ones dropped. */
export function billHeaderLines(s: BillHeaderSource): string[] {
  return [s.address, s.phone, ...s.lines, ...s.profileLines]
    .map((line) => (line ?? '').trim())
    .filter((line) => line !== '');
}
