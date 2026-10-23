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
  | 'invalid_cutoff';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
