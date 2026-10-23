// Credentials and CNICs are never stored, printed or migrated (CLAUDE.md rule 11, D-084).

/** Reviewed exceptions, as `Table.Column`: names only, never values (columns.json). */
export interface ColumnPolicy {
  /** Also dropped, on top of the credential names. */
  drop: string[];
  /** Kept although a value looks like a CNIC (reviewed by the owner). */
  allow: string[];
}

export const NO_POLICY: ColumnPolicy = { drop: [], allow: [] };

const CREDENTIAL_WORDS = new Set(['pass', 'pin', 'nic']);
/** Also inside a run of capitals (`BPCNIC`, `USERPWD`): rare enough in ordinary names to match anywhere. */
const CREDENTIAL_PARTS = /cnic|password|passwd|pwd/i;

/** The words of a column name, split at `_` and case changes: `CNICNo` → cnic, no. */
const words = (name: string) =>
  [...name.matchAll(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g)].map((m) => m[0].toLowerCase());

export const isCredentialColumn = (name: string): boolean =>
  CREDENTIAL_PARTS.test(name) || words(name).some((w) => CREDENTIAL_WORDS.has(w));

/** `12345-1234567-1` or 13 digits, the whole value. */
export const looksLikeCnic = (value: string): boolean => /^(\d{5}-\d{7}-\d|\d{13})$/.test(value.trim());
