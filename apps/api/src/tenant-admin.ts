// Tenant setup, the support password reset (PLT-11, D-083), a generated test catalog on staging (W1-21) and the
// posting rebuild check and apply (ACC-02, W1-08), run by `erp-tenant` on the server in a one-off
// container with the owner role's URL (migrate.env), like the migrate step. The input arrives as JSON on stdin
// so the password never appears in a command line or the environment; nothing secret is printed.
import { TenantSpec } from '@erp/contracts';
import { resetUserPassword, setupTenant } from '@erp/db';
import { seedGeneratedCatalog } from '@erp/db/testing';
import { applyRebuild, checkRebuild } from '@erp/posting';
import pg from 'pg';
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
  z.object({
    action: z.literal('seed-catalog'),
    environment: z.enum(['staging', 'prod']),
    tenantCode: z.string(),
    items: z.number().int().min(1).max(50_000),
  }),
  // Compare-only by default; `apply` rewrites the ledgers and is refused on a locked period (architecture §7).
  z.object({ action: z.literal('posting-check'), tenantCode: z.string() }),
  z.object({ action: z.literal('posting-rebuild'), tenantCode: z.string() }),
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
    list('updated', report.updated);
    list('drift (not applied)', report.drift);
    list('needs attention', report.needsAttention);
    if (report.created.length === 0 && report.updated.length === 0 && report.drift.length === 0)
      console.log('no changes');
  } else if (input.action === 'posting-check' || input.action === 'posting-rebuild') {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const found = await pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM erp.tenant_directory WHERE code = $1',
        [input.tenantCode],
      );
      const tenantId = found.rows[0]?.tenant_id ?? fail(`no shop ${input.tenantCode}`);
      if (input.action === 'posting-rebuild') {
        const r = await applyRebuild(url, tenantId, { userId: null, now: new Date() });
        console.log(`${input.tenantCode}: ${r.postings} postings rewritten from their documents`);
      }
      const { differences } = await checkRebuild(pool, tenantId);
      if (differences.length > 0) {
        console.log(`${input.tenantCode}: ${differences.length} differences`);
        for (const d of differences) console.log(`  ${d}`);
        process.exitCode = 1;
      } else console.log(`${input.tenantCode}: the ledgers match their documents`);
    } finally {
      await pool.end();
    }
  } else if (input.action === 'seed-catalog') {
    // Refuses production itself too, not only erp-tenant (W1-21).
    const r = await seedGeneratedCatalog(url, input);
    console.log(`${input.tenantCode}: ${r.items} generated items seeded in ${(r.ms / 1000).toFixed(1)} s`);
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
