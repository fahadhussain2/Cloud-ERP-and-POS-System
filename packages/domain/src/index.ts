// Pure, deterministic checkout rules shared by the POS and the API (CLAUDE.md rule 2).
// No I/O, no clock, no randomness: inputs in, results out. Every rule has golden test cases.
export {
  ACCOUNT_TYPES,
  REQUIRED_SYSTEM_ROLES,
  SYSTEM_ROLES,
  validateChartOfAccounts,
  type AccountType,
  type ChartAccount,
  type ChartProblem,
  type SystemRole,
} from './accounts';
export { allocate } from './allocate';
export {
  addLine,
  approve,
  billAmounts,
  canApprove,
  changeTier,
  emptyBill,
  hasListPrice,
  MAX_LINE_QTY,
  OVERRIDE_REASONS,
  parseDiscount,
  parseWholeAmount,
  pendingApprovals,
  priceNeed,
  removeLine,
  setBillDiscount,
  setQty,
  setUnitPrice,
  type Approval,
  type ApprovalKind,
  type ApprovalTarget,
  type ApprovedBy,
  type Bill,
  type BillAmounts,
  type BillApprovalValues,
  type BillLine,
  type LineAmounts,
  type LineApprovalValues,
  type NewLine,
  type OverrideReason,
  type PendingApproval,
  type PriceCheck,
} from './bill';
export { businessDate } from './business-date';
export {
  nextDeviceCode,
  nextPinState,
  PIN_MAX_FAILURES,
  pinProblem,
  type DeviceKind,
  type PinEvent,
  type PinProblem,
  type PinResult,
  type PinState,
} from './device';
export { DomainError, type DomainErrorCode } from './errors';
export { normalizeIdentifier } from './identifier';
export { add, money, mulBp, mulQty, negate, parseMoney, sub, sum, type Money } from './money';
export {
  can,
  canGivePinTo,
  canGrantRole,
  effectiveLimits,
  expandPermissions,
  isPermission,
  PERMISSIONS,
  ROLE_TEMPLATES,
  type Permission,
  type RoleGrant,
  type RoleLimits,
  type RoleTemplate,
  type RoleTemplateKey,
  type VoidWindow,
} from './permissions';
export { parseQty, qty, QTY_SCALE, type Qty } from './quantity';
export { roundCash, type CashRounding } from './rounding';
export {
  billCode,
  buildSaleDocument,
  documentNumber,
  parseBillCode,
  saleTotal,
  type BillCode,
  type DocumentFamily,
  type SaleContext,
  type SaleDocument,
  type SaleDocumentLine,
  type SaleDocumentOverride,
  type SaleTotal,
} from './sale-document';
export {
  checkTender,
  MAX_REFERENCE_LENGTH,
  quickCash,
  settleTender,
  type PaymentMethodCode,
  type PaymentMethodInfo,
  type SettledPayment,
  type Settlement,
  type Tender,
  type TenderLine,
  type TenderProblem,
} from './tender';
