import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import cases from '../golden/parse.json';
import type { DumpError } from './errors';
import { countInsertLines, parseScript, readDumpFile } from './parse';
import { runGolden, type GoldenFile } from './testing/golden';

runGolden(cases as GoldenFile<string>, (script) => [...parseScript(script, 'golden.sql')]);

const errorOf = (script: string): DumpError => {
  try {
    Array.from(parseScript(script, 'T.sql'));
  } catch (err) {
    return err as DumpError;
  }
  throw new Error('expected an error');
};

describe('parse errors', () => {
  it('name the file and line but never a value (it could be personal data)', () => {
    const err = errorOf("INSERT [dbo].[T] ([Phone]) VALUES (N'0300-1234567 unterminated)");
    expect(err.message).toContain('T.sql');
    expect(err.message).toContain('line 1');
    expect(err.message).not.toContain('0300');
    const bad = errorOf("INSERT [dbo].[T] ([a], [Phone]) VALUES (1, N'0300-1234567', 3)");
    expect(bad.message).not.toContain('0300');
  });
});

describe('the independent INSERT count', () => {
  it('counts lines that start an INSERT, without parsing them', () => {
    expect(
      countInsertLines('INSERT [dbo].[T] ([a]) VALUES (1)\r\n  insert [dbo].[T] ([a]) VALUES (2)\r\nGO\r\n'),
    ).toBe(2);
    expect(countInsertLines('SET IDENTITY_INSERT [dbo].[T] ON\r\n-- INSERT in a comment\r\n')).toBe(0);
  });
});

describe('reading a dump file', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legacy-read-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('decodes UTF-16 LE with its byte-order mark, as SSMS writes it', async () => {
    const file = join(dir, 'utf16.sql');
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("N'کراچی'\r\n", 'utf16le')]));
    const { text, sha256 } = await readDumpFile(file);
    expect(text).toBe("N'کراچی'\r\n");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a file that is not UTF-16 LE', async () => {
    const file = join(dir, 'utf8.sql');
    await writeFile(file, 'INSERT [dbo].[T] ([a]) VALUES (1)\r\n', 'utf8');
    await expect(readDumpFile(file)).rejects.toMatchObject({ code: 'not_utf16' });
  });
});
