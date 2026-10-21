#!/usr/bin/env node
// Lock test files during a bug fix so the fix changes the code, not the test (docs/07-DELIVERY-PROCESS.md §3).
//   node .claude/hooks/bugfix-lock.mjs lock path/to/thing.test.ts [more files]
//   node .claude/hooks/bugfix-lock.mjs unlock
//   node .claude/hooks/bugfix-lock.mjs status
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const lockFile = join(root, '.claude', 'bugfix-lock.json');
const [cmd, ...files] = process.argv.slice(2);

if (cmd === 'lock' && files.length) {
  writeFileSync(lockFile, JSON.stringify({ files: files.map((f) => f.replace(/\\/g, '/')), lockedAt: new Date().toISOString() }, null, 2));
  console.log(`Locked: ${files.join(', ')}`);
} else if (cmd === 'unlock') {
  if (existsSync(lockFile)) rmSync(lockFile);
  console.log('Unlocked.');
} else if (cmd === 'status') {
  console.log(existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : 'No test files locked.');
} else {
  console.log('Usage: bugfix-lock.mjs lock <test files...> | unlock | status');
  process.exit(1);
}
