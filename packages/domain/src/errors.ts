// Rule violations carry a stable code: the POS shows a translated message for it (i18n keys, CLAUDE.md
// rule 10) and the API maps it to an exception (D-079).
export type DomainErrorCode =
  | 'not_integer'
  | 'out_of_range'
  | 'invalid_number'
  | 'too_many_decimals'
  | 'invalid_minor_units'
  | 'invalid_basis_points'
  | 'invalid_increment'
  | 'bad_weights'
  | 'invalid_time_zone'
  | 'invalid_cutoff'
  // The bill (POS spec §10, W1-05)
  | 'invalid_quantity'
  | 'price_required'
  | 'invalid_price'
  | 'negative_amount'
  | 'invalid_discount'
  | 'discount_too_large'
  | 'unknown_line'
  | 'nothing_to_approve'
  | 'note_required';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
