import { canApprove, nextPinState, type ApprovalKind, type PinState, type RoleGrant } from '@erp/domain';

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
  if (approver.pinMustChange || !canApprove(opts.approverGrants, opts.branchId, opts.need, opts.discountBp))
    return { result: 'not_allowed', approverState: checked.state };
  return { result: 'approved', approverState: checked.state };
}
