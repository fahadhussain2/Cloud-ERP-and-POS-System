import type { RoleAssignment, RoleSummary, UserSummary } from '@erp/contracts';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';

import type { Api } from '../api';

// What the Staff screens read (W1-04): people for everyone with the screen; roles and branches only for those who
// may change people (admin.users), so a manager never asks for them.

export interface Branch {
  id: string;
  code: string;
  name: string;
}

export interface StaffData {
  users: UserSummary[] | null;
  roles: RoleSummary[];
  branches: Branch[];
  reload: () => Promise<void>;
}

export function useStaffData(api: Api, canAdmin: boolean): StaffData {
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);

  const fetchAll = useCallback(async () => {
    const [u, r, b] = await Promise.all([
      api('GET', '/api/users'),
      canAdmin ? api('GET', '/api/roles') : null,
      canAdmin ? api('GET', '/api/branches') : null,
    ]);
    return {
      users: u.status === 200 ? (u.body as UserSummary[]) : [],
      roles: r?.status === 200 ? (r.body as RoleSummary[]) : [],
      branches: b?.status === 200 ? (b.body as Branch[]) : [],
    };
  }, [api, canAdmin]);

  const show = useCallback((d: Awaited<ReturnType<typeof fetchAll>>) => {
    setUsers(d.users);
    setRoles(d.roles);
    setBranches(d.branches);
  }, []);

  useEffect(() => {
    let live = true;
    void fetchAll().then((d) => live && show(d));
    return () => {
      live = false;
    };
  }, [fetchAll, show]);

  const reload = useCallback(async () => show(await fetchAll()), [fetchAll, show]);
  return { users, roles, branches, reload };
}

/** The words for a refusal from the user-admin API, or the generic error. */
export function refusalText(t: TFunction, exists: (key: string) => boolean, body: unknown): string {
  const b = body as { error?: string; field?: string } | null;
  if (b?.error === 'duplicate' && b.field && exists(`staff.errors.duplicate_${b.field}`))
    return t(`staff.errors.duplicate_${b.field}`);
  if (b?.error && exists(`staff.errors.${b.error}`)) return t(`staff.errors.${b.error}`);
  return t('app.error');
}

/** The value a branch select uses for "all branches" (`branchId: null`). */
export const ALL_BRANCHES = 'all';
export const branchValue = (id: string | null) => id ?? ALL_BRANCHES;
export const branchFromValue = (v: string) => (v === ALL_BRANCHES ? null : v);

/** Checks or unchecks a role: checking adds it for `branchId`; unchecking removes it in every branch. */
export function toggleRole(
  assignments: readonly RoleAssignment[],
  roleId: string,
  on: boolean,
  branchId: string | null,
): RoleAssignment[] {
  const without = assignments.filter((a) => a.roleId !== roleId);
  return on ? [...without, { roleId, branchId }] : without;
}
