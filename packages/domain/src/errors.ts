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
  | 'note_required'
  // Finalize and print (POS spec §12–§13, W1-06)
  | 'invalid_tender'
  | 'empty_bill'
  | 'approval_pending'
  | 'invalid_sequence'
  | 'invalid_device_code'
  | 'invalid_bill_code'
  // Customers and credit (POS spec §15, W1-09)
  | 'invalid_customer'
  | 'invalid_phone'
  | 'credit_approval_pending'
  // The cash desk (cash desk spec, W1-10): the handover check's problems, and the session's
  | 'nothing_to_collect'
  | 'no_session'
  | 'not_session_cashier'
  | 'not_permitted'
  | 'already_handed_over'
  | 'received_not_rounded'
  | 'received_short'
  | 'session_open'
  | 'invalid_float'
  // Collections, cash-out and the drawer close (cash desk spec, W1-11)
  | 'no_customer'
  | 'invalid_method'
  | 'amount_not_positive'
  | 'amount_not_rounded'
  | 'reference_required'
  | 'reference_too_long'
  | 'note_too_long'
  | 'missing_target'
  | 'extra_target'
  | 'over_drawer'
  | 'invalid_currency'
  | 'invalid_count'
  | 'left_invalid'
  | 'reason_required'
  | 'own_variance'
  | 'not_acknowledger'
  // Hold, void and reissue (POS spec §17–§18, W1-12)
  | 'too_many'
  | 'label_too_long'
  | 'not_found'
  | 'bill_open'
  | 'other_device'
  | 'already_voided'
  | 'other_day'
  | 'handed_over'
  | 'window_none'
  | 'bill_voided'
  // Return and exchange (POS spec §19, W1-13)
  | 'return_over_quantity'
  | 'invalid_date'
  | 'invalid_reason'
  | 'invalid_condition'
  | 'bill_not_empty'
  | 'empty_return'
  | 'original_required'
  | 'other_item'
  | 'duplicate_line'
  | 'return_approval_pending'
  | 'no_return'
  | 'return_customer_mismatch'
  | 'refund_approval_pending'
  // Back-office accounting (W1-19)
  | 'invalid_start_month'
  // Voids and returns by payment, cash given back for a voided bill (W1-23, D-111)
  | 'payment_unanswered'
  | 'money_arrived'
  | 'payment_missing'
  | 'original_unpaid'
  | 'not_voided'
  | 'no_cash_taken'
  | 'already_given_back'
  | 'approver_required'
  | 'approver_is_cashier'
  | 'approver_not_permitted';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
