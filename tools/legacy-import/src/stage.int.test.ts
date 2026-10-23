import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stageDump } from './stage';

// Staging (W0-12, D-084) on synthetic dump files: no real data in git or CI.

const PASSWORD = 'legacy-secret-123';
const CNIC = '42101-1234567-1';

let admin: pg.Client;
let url: string;
let dbName: string;
let root: string;

/** A dump file as SSMS writes it: UTF-16 LE with a byte-order mark, CRLF line ends. */
const dumpFile = (dir: string, name: string, lines: string[]) =>
  writeFile(
    join(dir, name),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf16le')]),
  );

const items = [
  'USE [2024]',
  'GO',
  'SET IDENTITY_INSERT [dbo].[INV_Item] ON',
  "INSERT [dbo].[INV_Item] ([ItemID], [ItemName], [SalePrice], [Updated]) VALUES (N'0001234', N'OIL FILTER', CAST(1250.00 AS Decimal(18, 2)), CAST(0x0000B3AB00E7958C AS DateTime))",
  "INSERT [dbo].[INV_Item] ([ItemID], [ItemName], [SalePrice], [Updated]) VALUES (N'0001235', N'AIR FILTER', CAST(0.00 AS Decimal(18, 2)), NULL)",
  "INSERT [dbo].[INV_Item] ([ItemID], [ItemName], [SalePrice], [Updated]) VALUES (N'0001236', N'PLUG ''NGK''', CAST(450.50 AS Decimal(18, 2)), NULL)",
  'SET IDENTITY_INSERT [dbo].[INV_Item] OFF',
  'GO',
];
const users = (phone2: string) => [
  `INSERT [dbo].[Admin_Users] ([UserID], [UserName], [UserPassword], [CNICNo], [Nickname], [Phone2]) VALUES (1, N'admin', N'${PASSWORD}', N'${CNIC}', N'boss', N'${phone2}')`,
  `INSERT [dbo].[Admin_Users] ([UserID], [UserName], [UserPassword], [CNICNo], [Nickname], [Phone2]) VALUES (2, N'faizan', N'${PASSWORD}', NULL, NULL, NULL)`,
];

const dumpDir = async (name: string, files: Record<string, string[]>) => {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) await dumpFile(dir, file, lines);
  return dir;
};

const rows = async (sql: string) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<Record<string, unknown>>(sql)).rows;
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  const base = process.env['DATABASE_URL'];
  if (!base) throw new Error('DATABASE_URL is not set');
  admin = new pg.Client({ connectionString: base });
  await admin.connect();
  dbName = `legacy_test_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  url = u.toString();
  root = await mkdtemp(join(tmpdir(), 'legacy-stage-'));
});

afterAll(async () => {
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.end();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('staging a dump', () => {
  it('stages every table with its rows, as text, and the three counts agree', async () => {
    const dir = await dumpDir('good', {
      'dbo.INV_Item.Table.sql': items,
      'dbo.Admin_Users.Table.sql': users('0300-1234567'),
    });
    const report = await stageDump({ url, label: 'fixture', dumpDir: dir });

    expect(report.schema).toBe('legacy_fixture');
    const item = report.files.find((f) => f.file === 'dbo.INV_Item.Table.sql')!;
    expect(item).toMatchObject({ insertLines: 3, statements: 3, rowsParsed: 3, rowsStaged: 3 });
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.tables).toEqual([
      {
        table: 'INV_Item',
        staged: 'inv_item',
        columns: ['ItemID', 'ItemName', 'SalePrice', 'Updated'],
        dropped: [],
        rows: 3,
      },
    ]);
    expect(report.totals).toEqual({ files: 2, tables: 2, rows: 5 });

    expect(
      await rows(
        'SELECT itemid, itemname, saleprice, updated, _file, _line FROM legacy_fixture.inv_item ORDER BY _line',
      ),
    ).toEqual([
      {
        itemid: '0001234',
        itemname: 'OIL FILTER',
        saleprice: '1250.00',
        updated: '2025-12-06 14:03:10.333',
        _file: 'dbo.INV_Item.Table.sql',
        _line: 4,
      },
      {
        itemid: '0001235',
        itemname: 'AIR FILTER',
        saleprice: '0.00',
        updated: null,
        _file: 'dbo.INV_Item.Table.sql',
        _line: 5,
      },
      {
        itemid: '0001236',
        itemname: "PLUG 'NGK'",
        saleprice: '450.50',
        updated: null,
        _file: 'dbo.INV_Item.Table.sql',
        _line: 6,
      },
    ]);
    expect(
      await rows('SELECT file, rows_staged, insert_lines FROM legacy_fixture._files ORDER BY file'),
    ).toEqual([
      { file: 'dbo.Admin_Users.Table.sql', rows_staged: 2, insert_lines: 2 },
      { file: 'dbo.INV_Item.Table.sql', rows_staged: 3, insert_lines: 3 },
    ]);
  });

  it('never stores, reports or returns a password or a CNIC', async () => {
    const dir = await dumpDir('creds', { 'dbo.Admin_Users.Table.sql': users('0300-1234567') });
    const report = await stageDump({ url, label: 'creds', dumpDir: dir });

    expect(report.files[0]!.tables[0]).toMatchObject({
      table: 'Admin_Users',
      columns: ['UserID', 'UserName', 'Nickname', 'Phone2'],
      dropped: ['UserPassword', 'CNICNo'],
    });
    const columns = await rows(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'legacy_creds' AND table_name = 'admin_users' ORDER BY ordinal_position",
    );
    expect(columns.map((c) => c['column_name'])).toEqual([
      'userid',
      'username',
      'nickname',
      'phone2',
      '_file',
      '_line',
    ]);
    const everything = JSON.stringify([
      report,
      await rows('SELECT * FROM legacy_creds.admin_users'),
      await rows('SELECT * FROM legacy_creds._files'),
    ]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(CNIC);
  });

  it('stops on a CNIC-shaped value in another column, naming only the column', async () => {
    const dir = await dumpDir('cnic', { 'dbo.Admin_Users.Table.sql': users(CNIC) });
    const err = await stageDump({ url, label: 'cnic', dumpDir: dir }).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'personal_data' });
    expect(err.message).toContain('Admin_Users.Phone2');
    expect(err.message).not.toContain(CNIC);
    expect(await rows("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'legacy_cnic'")).toEqual(
      [],
    );
  });

  it('stages it once the column is reviewed and allowed', async () => {
    const dir = await dumpDir('allowed', { 'dbo.Admin_Users.Table.sql': users(CNIC) });
    const report = await stageDump({
      url,
      label: 'allowed',
      dumpDir: dir,
      policy: { drop: [], allow: ['Admin_Users.Phone2'] },
    });
    expect(report.totals.rows).toBe(2);
  });

  it('drops a column the reviewed list names', async () => {
    const dir = await dumpDir('dropped', { 'dbo.Admin_Users.Table.sql': users('0300-1234567') });
    const report = await stageDump({
      url,
      label: 'dropped',
      dumpDir: dir,
      policy: { drop: ['Admin_Users.Phone2'], allow: [] },
    });
    expect(report.files[0]!.tables[0]!.dropped).toEqual(['UserPassword', 'CNICNo', 'Phone2']);
  });

  it('replaces a label when it is staged again, and keeps other labels', async () => {
    const dir = await dumpDir('again', { 'dbo.INV_Item.Table.sql': items });
    await stageDump({ url, label: 'again', dumpDir: dir });
    await stageDump({ url, label: 'again', dumpDir: dir });
    await stageDump({ url, label: 'again2', dumpDir: dir });
    expect(await rows('SELECT count(*)::int AS n FROM legacy_again.inv_item')).toEqual([{ n: 3 }]);
    expect(await rows('SELECT count(*)::int AS n FROM legacy_again2.inv_item')).toEqual([{ n: 3 }]);
    expect(await rows('SELECT count(*)::int AS n FROM legacy_fixture.inv_item')).toEqual([{ n: 3 }]);
  });

  it('fails when the line scan and the parser disagree, and leaves the label as it was', async () => {
    const dir = await dumpDir('mismatch', {
      'dbo.T.Table.sql': [
        "INSERT [dbo].[T] ([a]) VALUES (N'one",
        "INSERT looks like a statement but is inside the string')",
      ],
    });
    await expect(stageDump({ url, label: 'fixture', dumpDir: dir })).rejects.toMatchObject({
      code: 'count_mismatch',
    });
    expect(await rows('SELECT count(*)::int AS n FROM legacy_fixture.inv_item')).toEqual([{ n: 3 }]);
  });

  it('refuses a bad label, an empty folder and a table split across different column lists', async () => {
    await expect(stageDump({ url, label: 'Bad Label', dumpDir: root })).rejects.toMatchObject({
      code: 'bad_label',
    });
    const empty = await dumpDir('empty', {});
    await expect(stageDump({ url, label: 'empty', dumpDir: empty })).rejects.toMatchObject({
      code: 'no_files',
    });
    const split = await dumpDir('split', {
      'dbo.T.Table.sql': ['INSERT [dbo].[T] ([a]) VALUES (1)', 'INSERT [dbo].[T] ([a], [b]) VALUES (1, 2)'],
    });
    await expect(stageDump({ url, label: 'split', dumpDir: split })).rejects.toMatchObject({
      code: 'columns_changed',
    });
  });
});
