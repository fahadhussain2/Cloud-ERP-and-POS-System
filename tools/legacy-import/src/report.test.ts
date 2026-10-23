import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatStagingReport, writeStagingReport } from './report';
import type { StagingReport } from './stage';

const report: StagingReport = {
  label: 'dec2025',
  schema: 'legacy_dec2025',
  stagedAt: '2026-10-24T05:00:00.000Z',
  files: [
    {
      file: 'dbo.Admin_Users.Table.sql',
      sha256: 'a'.repeat(64),
      insertLines: 17,
      statements: 17,
      rowsParsed: 17,
      rowsStaged: 17,
      tables: [
        {
          table: 'Admin_Users',
          staged: 'admin_users',
          columns: ['UserID', 'UserName'],
          dropped: ['UserPassword'],
          rows: 17,
        },
      ],
    },
    {
      file: 'dbo.INV_Item.Table.sql',
      sha256: 'b'.repeat(64),
      insertLines: 19552,
      statements: 19552,
      rowsParsed: 19552,
      rowsStaged: 19552,
      tables: [
        {
          table: 'INV_Item',
          staged: 'inv_item',
          columns: ['ItemID', 'ItemName'],
          dropped: [],
          rows: 19552,
        },
      ],
    },
  ],
  totals: { files: 2, tables: 2, rows: 19569 },
};

describe('the staging report', () => {
  it('lists every table with its counts, its staged columns and what was dropped', () => {
    const md = formatStagingReport(report);
    expect(md).toContain('# Staging report: dec2025');
    expect(md).toContain('| INV_Item | 19,552 | 19,552 | 19,552 | dbo.INV_Item.Table.sql |');
    expect(md).toContain('| Admin_Users | 17 | 17 | 17 | dbo.Admin_Users.Table.sql |');
    expect(md).toContain('**Dropped columns (never stored):** Admin_Users.UserPassword');
    expect(md).toContain('- **INV_Item** (`legacy_dec2025.inv_item`): ItemID, ItemName');
    expect(md).toContain('2 files, 2 tables, 19,569 rows');
  });

  it('says so when nothing was dropped', () => {
    const md = formatStagingReport({ ...report, files: [report.files[1]!] });
    expect(md).toContain('**Dropped columns (never stored):** none');
  });

  describe('on disk', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'legacy-report-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the report as Markdown and JSON in out/<label>/', async () => {
      const paths = await writeStagingReport(report, dir);
      expect(paths).toEqual([
        join(dir, 'dec2025', 'staging-report.md'),
        join(dir, 'dec2025', 'staging-report.json'),
      ]);
      expect(JSON.parse(await readFile(paths[1], 'utf8'))).toEqual(report);
      expect(await readFile(paths[0], 'utf8')).toBe(formatStagingReport(report));
    });
  });
});
