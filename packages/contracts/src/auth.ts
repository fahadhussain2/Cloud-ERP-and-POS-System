import { z } from 'zod';

// Back-office login (PLT-04, D-081). Shared by the API and the back office.

export const LoginRequest = z.object({
  /** The shop code, e.g. "delux"; remembered on the device. */
  tenantCode: z.string().trim().toLowerCase().min(2).max(32),
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const MeResponse = z.object({
  tenantId: z.uuid(),
  user: z.object({ id: z.uuid(), username: z.string(), fullName: z.string() }),
  permissions: z.array(z.string()),
  limits: z.object({
    maxDiscountBp: z.number().int(),
    voidWindow: z.enum(['none', 'same_day_before_handover', 'same_day']),
  }),
});
export type MeResponse = z.infer<typeof MeResponse>;
