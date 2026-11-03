import {
  can,
  canApprove,
  canApproveReturn,
  canVoid,
  nextPinState,
  type ApprovalKind,
  type PinState,
  type ReturnApprovalKind,
  type RoleGrant,
} from '@erp/domain';

import { unlockableStaff, type StaffUser } from './unlock';

// An approval on the same screen (POS spec §10, PLT-07): the approver's own PIN, checked offline against their verifier
// like the manager unlock (§5). Wrong PINs count towards the approver's own lock. The seller may approve their own
// price when they hold the permission (owner answer 2 to W1-05).

export type ApproverResult = 'approved' | 'wrong' | 'approver_locked' | 'not_allowed';

export async function checkApprover(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  branchId: string | null;
  need: ApprovalKind;
  discountBp: number | null;
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  return checkStaffPin({
    ...opts,
    allowed: (grants) => canApprove(grants, opts.branchId, opts.need, opts.discountBp),
  });
}

/** Going over a customer's credit limit or the offline cap (POS spec §15, D-013): `pos.credit.over_limit` here. */
export function checkCreditApprover(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  branchId: string | null;
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  return checkStaffPin({ ...opts, allowed: (grants) => can(grants, 'pos.credit.over_limit', opts.branchId) });
}

/** A void (POS spec §18, W1-12): `pos.void` here with a window other than `none` (`canVoid`). */
export function checkVoidApprover(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  branchId: string;
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  return checkStaffPin({ ...opts, allowed: (grants) => canVoid(grants, opts.branchId) === null });
}

/**
 * A return's approval (POS spec §19, D-051, W1-13): every permission its needs take here (`canApproveReturn`), e.g.
 * `pos.return.no_receipt` without a receipt, or `pos.override.approve` for a refund by transfer.
 */
export function checkReturnApprover(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  branchId: string;
  kinds: readonly ReturnApprovalKind[];
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  return checkStaffPin({ ...opts, allowed: (grants) => canApproveReturn(grants, opts.branchId, opts.kinds) });
}

/** A manager's *Try again* on a refused bill (POS spec §14, owner answer 4 to W1-07): `admin.devices` here. */
export function checkManager(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  branchId: string | null;
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  return checkStaffPin({ ...opts, allowed: (grants) => can(grants, 'admin.devices', opts.branchId) });
}

/**
 * A manager acknowledging a drawer variance at the close (CSH-07, owner answer 1 to W1-11): `cash.variance.approve`,
 * and never the session's own cashier (PRD §4).
 */
export function checkVarianceApprover(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  branchId: string | null;
  sessionCashierId: string;
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  return checkStaffPin({
    ...opts,
    allowed: (grants) =>
      opts.approver.id !== opts.sessionCashierId && can(grants, 'cash.variance.approve', opts.branchId),
  });
}

async function checkStaffPin(opts: {
  approver: StaffUser;
  approverState: PinState;
  approverGrants: readonly RoleGrant[];
  allowed: (grants: readonly RoleGrant[]) => boolean;
  pin: string;
  verify: (verifier: string, pin: string) => Promise<boolean>;
}): Promise<{ result: ApproverResult; approverState: PinState }> {
  const { approver, approverState } = opts;
  if (approverState.locked) return { result: 'approver_locked', approverState };
  if (approver.pinVerifier === null || unlockableStaff([approver]).length === 0)
    return { result: 'not_allowed', approverState };
  const checked = nextPinState(
    approverState,
    (await opts.verify(approver.pinVerifier, opts.pin)) ? 'correct' : 'wrong',
  );
  if (checked.result === 'wrong') return { result: 'wrong', approverState: checked.state };
  if (checked.result === 'locked') return { result: 'approver_locked', approverState: checked.state };
  // A right PIN, but not someone who may: a temporary PIN not yet replaced, or no permission in this branch.
  if (approver.pinMustChange || !opts.allowed(opts.approverGrants))
    return { result: 'not_allowed', approverState: checked.state };
  return { result: 'approved', approverState: checked.state };
}
