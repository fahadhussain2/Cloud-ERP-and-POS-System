#!/usr/bin/env node
// PreToolUse guard (docs/07-DELIVERY-PROCESS.md §4). Exit 2 blocks the tool call; stderr is shown to Claude.
// 1. sql_dump/ holds customer personal data and legacy credentials: no reads, searches or edits,
//    except shell commands that run the legacy importer (tools/legacy-import).
// 2. No .env files (except .env.example) and no secrets written into files.
// 3. Test files locked for a bug fix (.claude/bugfix-lock.json) cannot be edited.
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const raw = readFileSync(0, 'utf8');
let input;
try { input = JSON.parse(raw); } catch {
  // Unreadable input: fail closed if it mentions the legacy dump, otherwise let it through.
  if (/sql_dump/i.test(raw)) { process.stderr.write('Blocked by project hook: unreadable tool input mentioning sql_dump/.\n'); process.exit(2); }
  process.exit(0);
}
const tool = input.tool_name || '';
const ti = input.tool_input || {};
const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase();
const block = (msg) => { process.stderr.write(`Blocked by project hook: ${msg}\n`); process.exit(2); };

// ---- 1. sql_dump/ ----
const shell = tool === 'Bash' || tool === 'PowerShell';
const pathFields = [ti.file_path, ti.path, ti.pattern, ti.notebook_path, ti.glob].map(norm);
const touchesDump = (s) => /(^|[\/\s"'=])sql_dump(\/|$|[\s"'])/.test(s) || s.includes('/sql_dump/') || s.endsWith('/sql_dump');
if (shell) {
  const cmd = norm(ti.command);
  if (touchesDump(cmd) && !cmd.includes('legacy-import')) {
    block('sql_dump/ contains personal data and legacy credentials. Access it only through tools/legacy-import (CLAUDE.md rule 11).');
  }
} else if (pathFields.some(touchesDump)) {
  block('sql_dump/ contains personal data and legacy credentials. Read it only through tools/legacy-import (CLAUDE.md rule 11).');
}

// ---- 2. secrets ----
const writes = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool);
if (writes) {
  const target = norm(ti.file_path || ti.notebook_path);
  const name = basename(target);
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example') {
    block(`writing ${name} is not allowed. Secrets live in environment files outside git; commit only .env.example with placeholder values.`);
  }
  const texts = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e && e.new_string) : [])]
    .filter(Boolean).join('\n');
  const patterns = [
    [/-----BEGIN (RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/, 'a private key'],
    [/AKIA[0-9A-Z]{16}/, 'an AWS access key'],
    [/ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}/, 'a GitHub token'],
    [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
    [/https:\/\/[0-9a-f]{32}@[a-z0-9.-]*sentry\.io/, 'a Sentry DSN with key'],
    [/postgres(ql)?:\/\/[^:\s'"]+:[^@\s'"]{6,}@(?!localhost|127\.0\.0\.1|postgres[:\/])/i, 'a database URL with a real password'],
  ];
  for (const [re, what] of patterns) {
    if (re.test(texts)) block(`the content looks like it contains ${what}. Keep secrets in environment variables, never in files.`);
  }
}

// ---- 3. tests locked during a bug fix ----
if (writes) {
  const lockFile = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'bugfix-lock.json');
  if (existsSync(lockFile)) {
    try {
      const locked = (JSON.parse(readFileSync(lockFile, 'utf8')).files || []).map(norm);
      const target = norm(ti.file_path || ti.notebook_path);
      if (locked.some((f) => f && target.endsWith(f))) {
        block(`${basename(target)} is locked for this bug fix: fix the code, not the failing test. Unlock with: node .claude/hooks/bugfix-lock.mjs unlock`);
      }
    } catch { /* unreadable lock file: ignore */ }
  }
}
process.exit(0);
