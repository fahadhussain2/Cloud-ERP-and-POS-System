import { z } from 'zod';

// Device enrollment, device tokens and staff PIN (PLT-03, PLT-04, platform spec, D-082).

/** "k7q2 m9xd" → "K7Q2-M9XD": what staff type is normalized before checking. */
export const normalizeEnrollmentCode = (code: string): string => {
  const raw = code.toUpperCase().replace(/[\s-]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
};

const base64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(512);

export const CreateEnrollmentCodeRequest = z.object({
  branchId: z.uuid(),
  kind: z.enum(['counter', 'cash_desk', 'mobile']),
  name: z.string().trim().min(1).max(64).optional(),
});

/** `signature` is over canonicalJson({ tenantCode, code, publicKey }): proof that the device holds the key. */
export const EnrollRequest = z.object({
  tenantCode: z.string().trim().toLowerCase().min(2).max(32),
  code: z.string().trim().min(8).max(16).transform(normalizeEnrollmentCode),
  publicKey: base64url,
  signature: base64url,
});

export const ChallengeRequest = z.object({ tenantId: z.uuid(), deviceId: z.uuid() });

/** `signature` is over canonicalJson({ tenantId, deviceId, nonce }). */
export const TokenRequest = z.object({
  tenantId: z.uuid(),
  deviceId: z.uuid(),
  nonce: base64url,
  signature: base64url,
});

export const SetPinRequest = z.object({
  /** The user's current password: setting a PIN needs a fresh proof of identity. */
  password: z.string().min(1).max(256),
  pin: z.string().max(16),
});
