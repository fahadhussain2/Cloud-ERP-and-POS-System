// Free text on the desk's documents: trimmed, empty = none, with the lengths the documents allow (W1-11).

/** At most this many characters in a note on a collection, cash-out or close. */
export const MAX_NOTE_LENGTH = 200;

export const trimmedOrNull = (text: string | null): string | null => {
  const t = text?.trim() ?? '';
  return t === '' ? null : t;
};
