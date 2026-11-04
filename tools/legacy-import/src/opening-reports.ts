import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { OpeningResult } from './opening-load';

// The opening reports (W1-14, MIG-04, migration doc §7, §8): the reconciliation page to sign, and CSVs that open in
// Excel. Party files (opening/parties/) hold names and amounts and stay on this PC; summary.json holds totals and
// counts only.

type Cell = string | number | boolean | null | undefined;

const csvCell = (v: Cell) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: Cell[][]) =>
  '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const rupees = (minor: number) => (minor / 100).toFixed(2);
const units = (t: number) => (t / 1000).toFixed(3);
const html = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Report {
  file: string;
  title: string;
  why: string;
  header: string[];
  rows: Cell[][];
}

function reportsOf(r: OpeningResult): Report[] {
  const d = r.detail;
  return [
    {
      file: 'opening/doc-types.csv',
      title: 'Legacy document types in the stock tables',
      why: 'Confirm each sign (+1 adds stock, −1 takes it away) in opening.docTypes of the mapping file.',
      header: ['Table', 'Type', 'Name', 'Rows', 'Sign in the mapping'],
      rows: r.docTypes.map((t) => [t.source, t.docType, t.name, t.rows, t.sign ?? 'none']),
    },
    {
      file: 'opening/negative-stock.csv',
      title: 'Negative stock',
      why: 'Loaded negative (migration doc §4.1). For the first January cycle counts.',
      header: ['Item', 'Quantity'],
      rows: d.negative.map((x) => [x.code, units(x.qty)]),
    },
    {
      file: 'opening/zero-stock-recent-sales.csv',
      title: 'No stock, but sold in the last 90 days',
      why: 'For the first January cycle counts.',
      header: ['Item', 'Sale lines in 90 days'],
      rows: d.zeroWithSales.map((x) => [x.code, x.sold]),
    },
    {
      file: 'opening/no-cost.csv',
      title: 'Stock with no cost',
      why: 'Valued at 0 until fixed; the counter keeps the list price as the floor.',
      header: ['Item', 'Quantity'],
      rows: d.noCost.map((x) => [x.code, units(x.qty)]),
    },
    {
      file: 'opening/quantity-mismatch.csv',
      title: 'Closing stock differs from the legacy running balance',
      why: 'A missed document type, a wrong sign, or the period opening counted twice.',
      header: [
        'Item',
        'Computed',
        'Legacy running balance',
        'Period opening quantity',
        'From the stock records',
      ],
      rows: d.qtyMismatch.map((x) => [
        x.code,
        units(x.computed),
        units(x.running),
        units(x.periodOpening),
        units(x.fromRecords),
      ]),
    },
    {
      file: 'opening/cost-above-retail.csv',
      title: 'Opening cost above the Retail price',
      why: 'Fix the price or the cost.',
      header: ['Item', 'Cost (Rs)', 'Retail (Rs)'],
      rows: d.costAboveRetail.map((x) => [x.code, rupees(x.cost), rupees(x.retail)]),
    },
    {
      file: 'opening/unknown-items.csv',
      title: 'Legacy items with stock that are not in the shop',
      why: 'Run the masters import (pnpm legacy:import) for this label first.',
      header: ['Item'],
      rows: d.unknownItems.map((x) => [x]),
    },
    {
      file: 'opening/legacy-trial-balance.csv',
      title: 'Legacy trial balance up to the cutoff',
      why: 'Compared only: cash and banks come from the count and the statements, equity and P&L are not carried (posting rules §7).',
      header: ['Legacy account', 'Maps to', 'Dr − Cr (Rs)'],
      rows: d.legacyTrialBalance.map((x) => [x.legacyCode, x.mapsTo, rupees(x.amount)]),
    },
    {
      file: 'opening/opening-trial-balance.csv',
      title: 'The opening entry per account',
      why: 'Debits equal credits.',
      header: ['Account', 'Debit (Rs)', 'Credit (Rs)'],
      rows: d.openingTrialBalance.map((x) => [x.account, rupees(x.debit), rupees(x.credit)]),
    },
    {
      file: 'opening/parties/top-customers.csv',
      title: 'The 20 largest customer balances',
      why: 'Sign off before go-live (migration doc §8). Positive = they owe us.',
      header: ['Code', 'Name', 'Balance (Rs)'],
      rows: d.topCustomers.map((x) => [x.code, x.name, rupees(x.amount)]),
    },
    {
      file: 'opening/parties/top-suppliers.csv',
      title: 'The 20 largest supplier balances',
      why: 'Sign off before go-live (migration doc §8). Positive = we owe them.',
      header: ['Code', 'Name', 'Balance (Rs)'],
      rows: d.topSuppliers.map((x) => [x.code, x.name, rupees(x.amount)]),
    },
    {
      file: 'opening/parties/unknown-parties.csv',
      title: 'Legacy balances whose party is not in the shop',
      why: 'Run the masters import first, or check the sub-account code.',
      header: ['Role', 'Code', 'Balance (Rs)'],
      rows: d.unknownParties.map((x) => [x.role, x.code, rupees(x.amount)]),
    },
    {
      file: 'opening/parties/not-parties.csv',
      title: 'Balances on the control accounts that are not parties',
      why: 'The cash partners and lines without a sub-account: not carried. Check they are expected.',
      header: ['Role', 'Code', 'Balance (Rs)'],
      rows: d.excluded.map((x) => [x.role, x.code ?? '(none)', rupees(x.amount)]),
    },
  ];
}

/** Writes `<labelDir>/reports/opening/`: reconciliation.html, summary.json and the CSVs. Returns the page's path. */
export async function writeOpeningReports(r: OpeningResult, labelDir: string): Promise<string> {
  const dir = join(labelDir, 'reports');
  const reports = reportsOf(r);
  for (const rep of reports) {
    const path = join(dir, rep.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, csv(rep.header, rep.rows));
  }
  await mkdir(join(dir, 'opening'), { recursive: true });
  await writeFile(
    join(dir, 'opening', 'summary.json'),
    JSON.stringify(
      {
        label: r.label,
        status: r.status,
        differences: r.differences,
        totals: r.totals,
        checks: r.checks,
        findings: Object.fromEntries(reports.map((rep) => [rep.file, rep.rows.length])),
      },
      null,
      2,
    ) + '\n',
  );
  const t = r.totals;
  const checkRows = r.checks
    .map(
      (c) =>
        `<tr class="${c.status}"><td>${html(c.check)}</td><td>${html(c.ours)}</td><td>${html(c.legacy)}</td><td>${c.status}</td></tr>`,
    )
    .join('');
  const reportRows = reports
    .map(
      (rep) =>
        `<tr><td><a href="${rep.file}">${html(rep.title)}</a></td><td>${rep.rows.length}</td><td>${html(rep.why)}</td></tr>`,
    )
    .join('');
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opening balances: ${html(r.label)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:1000px}table{border-collapse:collapse;margin:12px 0 24px}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:start}td:nth-child(n+2){font-variant-numeric:tabular-nums}
tr.pass td:last-child{color:#166534}tr.differs td:last-child{color:#b91c1c;font-weight:600}tr.waiting td:last-child{color:#92400e}</style></head>
<body><h1>Opening balances: ${html(r.label)} (${r.status})</h1>
<p>${t.stockLines} items in stock, ${units(t.stockQty)} units worth Rs ${rupees(t.stockValue)} (${t.noCost} without a cost);
${t.customers} customers Rs ${rupees(t.customerTotal)}; ${t.suppliers} suppliers Rs ${rupees(t.supplierTotal)}.
${r.status === 'unchanged' ? `Already posted: ${r.differences} lines differ from this run (nothing was changed).` : ''}</p>
<h2>Reconciliation (migration doc §8)</h2>
<table><tr><th>Check</th><th>This system</th><th>Legacy</th><th>Result</th></tr>${checkRows}</table>
<p><em>waiting</em>: type the legacy report totals into <code>legacy-totals.json</code> next to this label's reports and run again.</p>
<h2>For your review</h2><table><tr><th>Report</th><th>Rows</th><th>What to do</th></tr>${reportRows}</table>
<p>Signed off by: ____________________ Date: ____________</p></body></html>
`;
  const path = join(dir, 'opening', 'reconciliation.html');
  await writeFile(path, page);
  return path;
}
