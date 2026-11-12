// `pnpm dev:reset-password <username> <temporary password> [database] [shop code]`: a temporary back-office password
// on this PC's database (default erp_dev, shop delux), to be changed at the next sign-in (D-083). It also lifts a
// lockout and ends the person's sessions. Local only: it refuses any database that isn't on this PC.
import { resetUserPassword } from '@erp/db';

import { hashPassword } from './auth/password';

const [username, password, database = 'erp_dev', shop = 'delux'] = process.argv.slice(2);
if (!username || !password) {
  console.error('usage: pnpm dev:reset-password <username> <temporary password> [database] [shop code]');
  process.exit(1);
}

const url = new URL(process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
  console.error(`refused: ${url.hostname} is not this PC (this is for local databases only)`);
  process.exit(1);
}
// The local migration role (packages/db/src/testing/database.ts), never used on a server.
url.username = 'erp_owner';
url.password = 'erp_owner_test';
url.pathname = `/${database}`;

await resetUserPassword(url.toString(), shop, username, { passwordHash: await hashPassword(password) });
console.info(`${shop}/${username} on ${database}: temporary password set; change it at the next sign-in`);
