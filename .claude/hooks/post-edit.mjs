#!/usr/bin/env node
// PostToolUse: format and lint the changed file (docs/07-DELIVERY-PROCESS.md §4).
// Uses the repo's own Prettier/ESLint from node_modules; does nothing until they are installed (Wave 0).
// Never blocks: lint problems are reported back to Claude as context.
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const ti = input.tool_input || {};
const file = (input.tool_response && input.tool_response.filePath) || ti.file_path;
if (!file || !existsSync(file) || /[\\/](node_modules|dist|build|sql_dump)[\\/]/.test(file)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// Call each tool's JS entry with Node directly: no shell, so paths with spaces work on Windows.
const bin = (rel) => {
  const p = join(root, 'node_modules', rel);
  return existsSync(p) ? p : null;
};
const ext = extname(file).toLowerCase();
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });

const prettier = bin('prettier/bin/prettier.cjs');
if (prettier && ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.md', '.yml', '.yaml', '.html'].includes(ext)) {
  run(prettier, ['--write', '--log-level', 'warn', file]);
}
const eslint = bin('eslint/bin/eslint.js');
if (eslint && ['.ts', '.tsx', '.js', '.mjs', '.cjs'].includes(ext)) {
  const r = run(eslint, ['--fix', '--no-warn-ignored', file]);
  if (r.status && r.status !== 0) {
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 4000);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `ESLint found problems in ${file}:\n${out}` } }));
  }
}
process.exit(0);
