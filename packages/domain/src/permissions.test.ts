import { describe, expect, it } from 'vitest';

import permissionCases from '../golden/permissions.json';
import grantCases from '../golden/role-grant.json';
import limitCases from '../golden/role-limits.json';
import {
  can,
  canGivePinTo,
  canGrantRole,
  effectiveLimits,
  expandPermissions,
  isPermission,
  PERMISSIONS,
  ROLE_TEMPLATES,
  type RoleGrant,
  type RoleLimits,
  type RoleTemplateKey,
} from './permissions';
import { runGolden, type GoldenFile } from './testing/golden';

const grant = (template: RoleTemplateKey, branchId: string | null = null): RoleGrant => ({
  ...ROLE_TEMPLATES[template],
  branchId,
});

runGolden(permissionCases as GoldenFile<{ roles: RoleTemplateKey[]; permission: string }>, (i) => {
  if (!isPermission(i.permission)) throw new Error(`not in the catalog: ${i.permission}`);
  return can(
    i.roles.map((r) => grant(r)),
    i.permission,
    'b1',
  );
});

type GrantInput =
  | { template: RoleTemplateKey; branchId: string | null }
  | { permissions: string[]; limits: RoleLimits; branchId: string | null };

runGolden(limitCases as GoldenFile<{ grants: GrantInput[]; branchId: string }>, (i) =>
  effectiveLimits(
    i.grants.map((g) =>
      'template' in g
        ? grant(g.template, g.branchId)
        : { permissions: g.permissions, limits: g.limits, branchId: g.branchId },
    ),
    i.branchId,
  ),
);

const toGrant = (g: GrantInput): RoleGrant =>
  'template' in g
    ? grant(g.template, g.branchId)
    : { permissions: g.permissions, limits: g.limits, branchId: g.branchId };

runGolden(
  grantCases as GoldenFile<{
    grants: GrantInput[];
    role: { template: RoleTemplateKey } | { permissions: string[] };
    branchId: string | null;
  }>,
  (i) =>
    canGrantRole(
      i.grants.map(toGrant),
      'template' in i.role ? ROLE_TEMPLATES[i.role.template].permissions : i.role.permissions,
      i.branchId,
    ),
);

describe('who may give a temporary PIN (W1-04, D-091)', () => {
  it('a manager gives one to salesmen and cashiers, even with rights the manager lacks', () => {
    expect(canGivePinTo([grant('manager')], [grant('salesman')])).toBe(true);
    expect(canGivePinTo([grant('manager')], [grant('cashier')])).toBe(true);
    expect(canGivePinTo([grant('manager')], [])).toBe(true);
  });

  it('a manager gives none to an Owner or to someone with user admin', () => {
    expect(canGivePinTo([grant('manager')], [grant('owner')])).toBe(false);
    const staffAdmin: RoleGrant = { ...grant('salesman'), permissions: ['admin.users'] };
    expect(canGivePinTo([grant('manager')], [staffAdmin])).toBe(false);
  });

  it('someone who outranks them does: the Owner gives one to anyone', () => {
    expect(canGivePinTo([grant('owner')], [grant('owner')])).toBe(true);
    expect(canGivePinTo([grant('owner')], [grant('manager'), grant('accountant')])).toBe(true);
  });

  it('nobody without admin.devices gives one', () => {
    expect(canGivePinTo([grant('salesman')], [grant('salesman')])).toBe(false);
    expect(canGivePinTo([grant('manager', 'b1')], [grant('salesman')])).toBe(false);
  });
});

describe('role templates', () => {
  it('use only permissions from the catalog', () => {
    for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
      for (const p of template.permissions) expect(p === '*' || isPermission(p), `${key}: ${p}`).toBe(true);
    }
  });

  it('match the reviewed role matrix (update it deliberately with `vitest -u`)', async () => {
    const matrix = Object.fromEntries(
      (Object.keys(ROLE_TEMPLATES) as RoleTemplateKey[]).map((key) => [
        key,
        Object.fromEntries(PERMISSIONS.map((p) => [p, can([grant(key)], p, 'b1')])),
      ]),
    );
    await expect(`${JSON.stringify(matrix, null, 2)}\n`).toMatchFileSnapshot(
      '../golden/role-matrix.snap.json',
    );
  });

  it('expand * to the whole catalog for display', () => {
    expect(expandPermissions([grant('owner')], 'b1')).toEqual([...PERMISSIONS]);
    expect(expandPermissions([grant('salesman', 'b2')], 'b1')).toEqual([]);
  });

  it('only count a branch-scoped grant in its branch, and every branch-free grant everywhere', () => {
    expect(can([grant('manager', 'b2')], 'pos.void', 'b1')).toBe(false);
    expect(can([grant('manager', 'b2')], 'pos.void', 'b2')).toBe(true);
    expect(can([grant('manager', 'b2')], 'pos.void', null)).toBe(false);
    expect(can([grant('manager')], 'pos.void', null)).toBe(true);
  });
});
