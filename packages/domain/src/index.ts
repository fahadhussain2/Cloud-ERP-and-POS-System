// Pure, deterministic checkout rules shared by the POS and the API (CLAUDE.md rule 2).
// No I/O, no clock, no randomness: inputs in, results out. Every rule has golden test cases.
export { allocate } from './allocate';
export { businessDate } from './business-date';
export { DomainError, type DomainErrorCode } from './errors';
export { add, money, mulBp, mulQty, negate, parseMoney, sub, sum, type Money } from './money';
export { parseQty, qty, QTY_SCALE, type Qty } from './quantity';
export { roundCash, type CashRounding } from './rounding';
