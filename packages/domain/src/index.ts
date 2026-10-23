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
export { add, money, mulBp, mulQty, negate, parseMoney, sub, sum, type Money } from './money';
export {
  can,
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
