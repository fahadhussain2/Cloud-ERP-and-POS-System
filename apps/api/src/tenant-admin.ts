// Tenant setup and the support password reset (PLT-11, D-083), run by `erp-tenant` on the server in a one-off
// container with the owner role's URL (migrate.env), like the migrate step. The input arrives as JSON on stdin
// so the password never appears in a command line or the environment; nothing secret is printed.
import { TenantSpec } from '@erp/contracts';
import { resetUserPassword, setupTenant } from '@erp/db';
import { z } from 'zod';

import { hashPassword, passwordProblem } from './auth/password';

const Input = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('setup'),
    spec: TenantSpec,
    ownerPassword: z.string(),
    mustChangePassword: z.boolean(),
  }),
  z.object({
    action: z.literal('reset-password'),
    tenantCode: z.string(),
    username: z.string(),
    password: z.string(),
  }),
]);

const fail = (message: string): never => {
  console.error(`tenant-admin: ${message}`);
  process.exit(1);
};

const url = process.env['MIGRATION_DATABASE_URL'] ?? fail('MIGRATION_DATABASE_URL is not set');
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let raw: unknown;
try {
  raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  fail('stdin is not JSON');
}
const parsed = Input.safeParse(raw);
if (!parsed.success) {
  // Paths and messages only: the input holds a password.
  fail(`invalid input:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
}
const input = parsed.data!;

try {
  if (input.action === 'setup') {
    const problem = passwordProblem(input.ownerPassword, input.spec.owner.username);
    if (problem) fail(`the password is not acceptable: ${problem}`);
    const report = await setupTenant(url, input.spec, {
      ownerPasswordHash: await hashPassword(input.ownerPassword),
      mustChangePassword: input.mustChangePassword,
    });
    const list = (title: string, items: string[]) =>
      console.log(items.length ? `${title}:\n${items.map((i) => `  ${i}`).join('\n')}` : `${title}: none`);
    console.log(`tenant ${input.spec.code} (${report.tenantId})`);
    list('created', report.created);
    list('drift (not applied)', report.drift);
    list('needs attention', report.needsAttention);
    if (report.created.length === 0 && report.drift.length === 0) console.log('no changes');
  } else {
    const problem = passwordProblem(input.password, input.username);
    if (problem) fail(`the password is not acceptable: ${problem}`);
    await resetUserPassword(url, input.tenantCode, input.username, {
      passwordHash: await hashPassword(input.password),
    });
    console.log(
      `${input.username} in ${input.tenantCode}: temporary password set; it must be changed at login`,
    );
  }
} catch (err) {
  fail((err as Error).message);
}
