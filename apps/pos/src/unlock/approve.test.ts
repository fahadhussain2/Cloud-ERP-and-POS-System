import { ROLE_TEMPLATES, type RoleGrant, type RoleTemplateKey } from '@erp/domain';
import { describe, expect, it } from 'vitest';

import { checkApprover, checkManager } from './approve';
import type { StaffUser } from './unlock';

// An approver's PIN on the same screen (POS spec §10, PLT-07), checked offline like the manager unlock (§5).

const person = (over: Partial<StaffUser> = {}): StaffUser => ({
  id: 'm1',
  fullName: 'Tariq',
  shortCode: '41',
  pinVerifier: 'pin:4321',
  pinMustChange: false,
  status: 'active',
  deletedAt: null,
  ...over,
});
const verify = (verifier: string, pin: string) => Promise.resolve(verifier === `pin:${pin}`);
const open = { failures: 0, locked: false };
const role = (template: RoleTemplateKey, branchId: string | null = null): RoleGrant => ({
  ...ROLE_TEMPLATES[template],
  branchId,
});
const check = (over: Partial<Parameters<typeof checkApprover>[0]> = {}) =>
  checkApprover({
    approver: person(),
    approverState: open,
    approverGrants: [role('manager')],
    branchId: 'b1',
    need: 'below_floor',
    discountBp: 1725,
    pin: '4321',
    verify,
    ...over,
  });

describe('an approval by PIN', () => {
  it("a manager's right PIN approves below the floor, and clears their earlier mistakes", async () => {
    expect(await check({ approverState: { failures: 2, locked: false } })).toEqual({
      result: 'approved',
      approverState: open,
    });
  });

  it('a wrong PIN counts towards the approver’s own lock; the 5th locks them', async () => {
    let approverState = open;
    for (let i = 1; i <= 5; i++) {
      const r = await check({ pin: '0000', approverState });
      approverState = r.approverState;
      expect(r.result).toBe(i < 5 ? 'wrong' : 'approver_locked');
    }
    expect(approverState).toEqual({ failures: 5, locked: true });
    expect((await check({ approverState })).result).toBe('approver_locked');
  });

  it("a salesman's right PIN is refused (no pos.price.below_floor)", async () => {
    expect(await check({ approverGrants: [role('salesman')] })).toEqual({
      result: 'not_allowed',
      approverState: open,
    });
  });

  it('a manager role for another branch is refused', async () => {
    expect((await check({ approverGrants: [role('manager', 'b2')] })).result).toBe('not_allowed');
  });

  it('a temporary PIN not yet replaced is refused', async () => {
    expect((await check({ approver: person({ pinMustChange: true }) })).result).toBe('not_allowed');
  });

  it('someone without a PIN, or no longer active, is refused without counting', async () => {
    expect(await check({ approver: person({ pinVerifier: null }) })).toEqual({
      result: 'not_allowed',
      approverState: open,
    });
    expect((await check({ approver: person({ status: 'disabled' }) })).result).toBe('not_allowed');
  });

  it('past the seller’s limit: the approver’s own limit must cover the discount', async () => {
    const limited: RoleGrant = {
      permissions: ['pos.override.approve'],
      limits: { maxDiscountBp: 1000, voidWindow: 'none' },
      branchId: null,
    };
    expect((await check({ need: 'below_list', discountBp: 1000, approverGrants: [limited] })).result).toBe(
      'approved',
    );
    expect((await check({ need: 'below_list', discountBp: 1001, approverGrants: [limited] })).result).toBe(
      'not_allowed',
    );
  });
});

describe("a manager's Try again on a refused bill (POS spec §14, W1-07)", () => {
  const manager = (over: Partial<Parameters<typeof checkManager>[0]> = {}) =>
    checkManager({
      approver: person(),
      approverState: open,
      approverGrants: [role('manager')],
      branchId: 'b1',
      pin: '4321',
      verify,
      ...over,
    });

  it('a manager with admin.devices here may; a salesman or another branch’s manager may not', async () => {
    expect((await manager()).result).toBe('approved');
    expect((await manager({ approverGrants: [role('salesman')] })).result).toBe('not_allowed');
    expect((await manager({ approverGrants: [role('manager', 'b2')] })).result).toBe('not_allowed');
  });

  it('a wrong PIN counts towards the manager’s own lock', async () => {
    expect(await manager({ pin: '0000' })).toEqual({
      result: 'wrong',
      approverState: { failures: 1, locked: false },
    });
  });
});
