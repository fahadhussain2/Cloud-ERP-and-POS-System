import { z } from 'zod';

// Staff and user admin (W1-04 plan; PLT-04, PLT-05; D-081). Shared by the API and the back office.

/** Blank optional text becomes null, so a cleared field removes the value. */
const optionalText = <T extends z.ZodType<string>>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), inner.nullable().optional());

/** The login name: fixed once created (it's in the audit trail). Same rule as the `users.username` check. */
export const Username = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,64}$/);
/** For picking yourself on a counter (W0-10). Same rule as the `users.short_code` check. */
export const ShortCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,8}$/);

/** A role for one branch, or every branch (`branchId: null`). */
export const RoleAssignment = z.object({ roleId: z.uuid(), branchId: z.uuid().nullable() });
export type RoleAssignment = z.infer<typeof RoleAssignment>;

export const CreateUserRequest = z.object({
  username: Username,
  fullName: z.string().trim().min(1).max(120),
  shortCode: optionalText(ShortCode),
  email: optionalText(z.email().max(254)),
  roles: z.array(RoleAssignment).max(20),
  /** Gives back-office access; must be changed at the first sign-in (D-083). Omitted = counter only. */
  temporaryPassword: z.string().min(1).max(256).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

/** Only what may change; the username is fixed. */
export const UpdateUserRequest = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  shortCode: optionalText(ShortCode),
  email: optionalText(z.email().max(254)),
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export const SetRolesRequest = z.object({ roles: z.array(RoleAssignment).max(20) });
export type SetRolesRequest = z.infer<typeof SetRolesRequest>;

export const TemporaryPasswordRequest = z.object({ temporaryPassword: z.string().min(1).max(256) });
export type TemporaryPasswordRequest = z.infer<typeof TemporaryPasswordRequest>;

/** One person in `GET /api/users`. Never a password hash or PIN verifier. */
export const UserSummary = z.object({
  id: z.uuid(),
  username: z.string(),
  fullName: z.string(),
  shortCode: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
  hasPassword: z.boolean(),
  hasPin: z.boolean(),
  pinMustChange: z.boolean(),
  lastLoginAt: z.string().nullable(),
  /** May the person signed in give this one a temporary PIN (canGivePinTo, D-091)? */
  canGivePin: z.boolean(),
  roles: z.array(
    z.object({
      roleId: z.uuid(),
      name: z.string(),
      templateKey: z.string().nullable(),
      branchId: z.uuid().nullable(),
    }),
  ),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const RoleSummary = z.object({ id: z.uuid(), name: z.string(), templateKey: z.string().nullable() });
export type RoleSummary = z.infer<typeof RoleSummary>;

/** Why a user-admin change was refused (409 unless noted). */
export type UserAdminError =
  | 'duplicate' // with `field`
  | 'cannot_grant' // 403
  | 'self'
  | 'last_owner'
  | 'weak_password'; // 400
