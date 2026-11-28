import { z } from 'zod';

// Back-office login (PLT-04, D-081). Shared by the API and the back office.

export const LoginRequest = z.object({
  /** The shop code, e.g. "delux"; remembered on the device. */
  tenantCode: z.string().trim().toLowerCase().min(2).max(32),
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** The back office's theme (PLT-13, W2-07): System follows the computer's setting. */
export const Theme = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof Theme>;

/** A person's own settings, saved with PUT /api/users/me/settings (W2-07). */
export const UpdateSettingsRequest = z.object({ theme: Theme });
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

export const MeResponse = z.object({
  tenantId: z.uuid(),
  user: z.object({ id: z.uuid(), username: z.string(), fullName: z.string() }),
  permissions: z.array(z.string()),
  limits: z.object({
    maxDiscountBp: z.number().int(),
    voidWindow: z.enum(['none', 'same_day_before_handover', 'same_day']),
  }),
  /** When true, the API allows only me, logout and the password change until it is changed (D-083). */
  mustChangePassword: z.boolean(),
  /** The shop's name (W1-25), for the reports' print header (W2-01). */
  shopName: z.string(),
  /** The person's theme, System until chosen (W2-07, D-120). */
  theme: Theme,
});
export type MeResponse = z.infer<typeof MeResponse>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
