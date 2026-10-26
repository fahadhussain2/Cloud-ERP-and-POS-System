// Adds shadcn/ui components with the CLI (D-066): `pnpm --filter @erp/ui ui:add button dialog …`.
// The CLI version is pinned (dependencies at least two weeks old). Its import rewriting turns our utils alias
// (`@erp/ui/lib/utils`) into a package named `cn` and installs that unrelated package, so this script runs the CLI,
// then points the imports back at our `cn` and removes the package.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = 'shadcn@4.21.4';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = process.argv.slice(2);
if (names.length === 0) throw new Error('usage: pnpm --filter @erp/ui ui:add <component…>');

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const run = (args: string[]) =>
  execFileSync(pnpm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

run(['dlx', CLI, 'add', ...names, '--yes', '--overwrite']);

const dir = join(root, 'src', 'components', 'ui');
for (const file of readdirSync(dir)) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  const fixed = text.replace(/from "cn"/g, 'from "@erp/ui/lib/utils"');
  if (fixed !== text) writeFileSync(path, fixed);
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
if (pkg.dependencies?.cn) {
  delete pkg.dependencies.cn;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  run(['install']);
}
console.info('Added. Check new dependencies are in the pnpm catalog at a version at least two weeks old.');
