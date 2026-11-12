import type pg from 'pg';

import retail from '../../templates/retail-coa.json';

// A test tenant's chart of accounts (W1-08): the retail template plus one bank, so pushed sales can be posted.
// Run inside withTenant. Real tenants get theirs from the tenant setup (D-083).

/** Adds the template accounts and a bank `BANK` (account 1150); returns account ids by code and the bank's id. */
export async function seedChart(
  c: pg.ClientBase,
  tenantId: string,
): Promise<{ accounts: Record<string, string>; bankId: string }> {
  const accounts: Record<string, string> = {};
  const rows = [
    ...retail.accounts,
    { code: '1150', name: 'Bank', type: 'asset', parentCode: '1100', isPostable: true, systemRole: null },
  ];
  for (const a of rows) {
    const r = await c.query<{ id: string }>(
      `INSERT INTO erp.accounts (tenant_id, code, name, type, parent_id, is_postable, system_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        tenantId,
        a.code,
        a.name,
        a.type,
        a.parentCode === null ? null : accounts[a.parentCode],
        a.isPostable,
        a.systemRole,
      ],
    );
    accounts[a.code] = r.rows[0]!.id;
  }
  const bank = await c.query<{ id: string }>(
    `INSERT INTO erp.bank_accounts (tenant_id, code, name, kind, gl_account_id) VALUES ($1, 'BANK', 'Bank', 'bank', $2)
     RETURNING id`,
    [tenantId, accounts['1150']],
  );
  return { accounts, bankId: bank.rows[0]!.id };
}
