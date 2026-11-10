// A draft with nothing typed in it (owner's review of W1-19): it can't post, and it would only clutter the lists and
// the lock checklist, so saving it is refused. A line counts once it has an item, an account or an amount; the
// header alone (a date, a location already filled in) is not something to keep.

/** One line of a back-office draft, in whichever shape its document has. */
export interface DraftLine {
  itemId?: string | null;
  accountId?: string | null;
  debit?: number;
  credit?: number;
  /** A quantity alone, with no item, is not something to keep. */
  qty?: number;
}

/** Whether no line of the draft has an item, an account or an amount. */
export function isEmptyDraft(lines: readonly DraftLine[]): boolean {
  return !lines.some((l) => !!l.itemId || !!l.accountId || (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
}
