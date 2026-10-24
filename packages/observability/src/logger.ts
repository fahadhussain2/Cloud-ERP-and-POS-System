import pino, { type DestinationStream, type Logger } from 'pino';

import { currentContext } from './context';

// JSON logs for every app (architecture §11.2, §11.7, D-086): app, env and version on each line, the request context
// as snake_case fields, and secrets redacted wherever they appear (CI-tested).

/** Keys that are never logged, at any of the first three levels and in request/response headers. */
const SECRET_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'ownerPassword',
  'password_hash',
  'passwordHash',
  'pin',
  'pinVerifier',
  'pin_verifier',
  'token',
  'accessToken',
  'deviceToken',
  'token_hash',
  'secret',
  'privateKey',
  'apiKey',
  'code_hash',
];
export const REDACT_PATHS = [
  ...SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

export interface LoggerOptions {
  app: string;
  env: string;
  version: string;
  level?: string;
  /** Where lines go; stdout by default (Alloy reads the container logs). */
  destination?: DestinationStream;
}

const FIELDS = [
  ['requestId', 'request_id'],
  ['traceId', 'trace_id'],
  ['tenantId', 'tenant_id'],
  ['branchId', 'branch_id'],
  ['userId', 'user_id'],
  ['deviceId', 'device_id'],
] as const;

export function createLogger({ app, env, version, level = 'info', destination }: LoggerOptions): Logger {
  return pino(
    {
      level,
      base: { app, env, version },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      mixin() {
        const ctx = currentContext();
        if (!ctx) return {};
        const out: Record<string, string> = {};
        for (const [from, to] of FIELDS) if (ctx[from] !== undefined) out[to] = ctx[from];
        return out;
      },
    },
    destination,
  );
}
