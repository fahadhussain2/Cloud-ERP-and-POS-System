import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { GROUPS, type ImportResult } from './load';

// The cleanup reports for the owner (migration doc §7, D-085): CSV files that open in Excel and an index page.
// Party reports hold names and masked phones; summary.json holds counts only.

type Cell = string | number | boolean | null | undefined;

const csvCell = (v: Cell) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** UTF-8 with a byte-order mark, so Excel shows Urdu correctly. */
const csv = (header: string[], rows: Cell[][]) =>
  '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const rupees = (minor: number) => (minor / 100).toFixed(2);
const html = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Report {
  file: string;
  title: string;
  why: string;
  header: string[];
  rows: Cell[][];
}

function reportsOf(r: ImportResult): Report[] {
  const f = r.findings;
  const phones = (code: string) => (r.partyPhones[code] ?? []).join(' / ');
  return [
    {
      file: 'catalog/brand-countries.csv',
      title: 'Brands that are countries',
      why: 'These became the origin; the brand is left empty. Confirm.',
      header: ['Brand', 'Origin', 'Items'],
      rows: f.brandCountries.map((b) => [b.brand, b.origin, b.items]),
    },
    {
      file: 'catalog/brand-maybe-country.csv',
      title: 'Brands that look like a country',
      why: 'Kept as brands. Add them to countryBrands in the mapping if they are countries.',
      header: ['Brand', 'Items'],
      rows: f.brandMaybeCountry.map((b) => [b.brand, b.items]),
    },
    {
      file: 'catalog/partno-not-oem.csv',
      title: 'PartNo values not taken as part numbers',
      why: 'Added to the spec instead. Colour, model code or a real part number?',
      header: ['Item', 'PartNo'],
      rows: f.partNoNotOem.map((x) => [x.item, x.partNo]),
    },
    {
      file: 'catalog/manufacture-spec.csv',
      title: 'Manufacture values not on the vehicle-make list',
      why: 'Kept as the item spec. Add real makes to vehicleMakes in the mapping.',
      header: ['Value', 'Items'],
      rows: f.manufactureSpec.map((x) => [x.value, x.items]),
    },
    {
      file: 'catalog/model-text.csv',
      title: 'Model values not read as years',
      why: 'Kept as the model name on the vehicle tag.',
      header: ['Value', 'Items'],
      rows: f.modelText.map((x) => [x.value, x.items]),
    },
    {
      file: 'catalog/price-zero.csv',
      title: 'Price 0',
      why: 'Fix before go-live.',
      header: ['Item', 'Name'],
      rows: f.priceZero.map((x) => [x.item, x.name]),
    },
    {
      file: 'catalog/cost-above-price.csv',
      title: 'Cost above the sale price',
      why: 'Fix before go-live.',
      header: ['Item', 'Name', 'Cost (Rs)', 'Price (Rs)'],
      rows: f.costAbovePrice.map((x) => [x.item, x.name, rupees(x.cost), rupees(x.price)]),
    },
    {
      file: 'catalog/no-cost.csv',
      title: 'No cost',
      why: 'The opening stock needs a cost (migration doc §4.1).',
      header: ['Item', 'Name'],
      rows: f.noCost.map((x) => [x.item, x.name]),
    },
    {
      file: 'catalog/rounded-amounts.csv',
      title: 'Amounts rounded to the paisa',
      why: 'The legacy amount had more decimals.',
      header: ['Item', 'Field'],
      rows: f.roundedAmounts.map((x) => [x.item, x.field]),
    },
    {
      file: 'catalog/duplicate-names.csv',
      title: 'Items with the same name',
      why: 'Merge or keep; the importer never merges.',
      header: ['Name', 'Items'],
      rows: f.duplicateNames.map((x) => [x.name, x.items.join(' ')]),
    },
    {
      file: 'catalog/duplicate-oem.csv',
      title: 'The same OEM number on several items',
      why: 'Alternatives are fine; check for duplicates.',
      header: ['OEM', 'Items'],
      rows: f.duplicateOem.map((x) => [x.oem, x.items.join(' ')]),
    },
    {
      file: 'catalog/unknown-references.csv',
      title: 'References to rows that do not exist',
      why: 'A category, unit, brand, make, manufacture or default supplier the dump does not have.',
      header: ['Item', 'Field', 'Value'],
      rows: f.unknownReferences.map((x) => [x.item, x.field, x.value]),
    },
    {
      file: 'catalog/missing.csv',
      title: 'Imported before, not in this dump',
      why: 'Kept, not deleted. Check whether they were removed in the legacy system.',
      header: ['What', 'Code'],
      rows: f.missing.map((x) => [x.what, x.code]),
    },
    {
      file: 'accounts/mapping.csv',
      title: 'Legacy accounts and where they went',
      why: 'Template accounts, new expense accounts, drawings, retired.',
      header: ['Legacy code', 'Name', 'Goes to'],
      rows: f.accounts.mapped.map((x) => [x.legacyCode, x.name, x.to]),
    },
    {
      file: 'accounts/unmapped.csv',
      title: 'Legacy accounts with no rule',
      why: 'Add a rule to the mapping before the rehearsals.',
      header: ['Legacy code', 'Name'],
      rows: f.accounts.unmapped.map((x) => [x.legacyCode, x.name]),
    },
    {
      file: 'parties/credit-customers.csv',
      title: 'Credit customers',
      why: "Their terms on the counter (D-085, W1-09). Set limits, caps and tiers in the mapping's partyCredit and partyTiers before go-live, then run the import again.",
      header: [
        'Code',
        'Name',
        'Tier',
        'Credit allowed',
        'Limit (Rs)',
        'Offline cap (Rs/day)',
        'Legacy balance (Rs, this copy)',
        'Phones',
      ],
      rows: f.parties.creditCustomers.map((x) => [
        x.code,
        x.name,
        x.tier,
        x.creditAllowed ? 'yes' : 'no',
        x.creditLimit === null ? 'no limit' : rupees(x.creditLimit),
        rupees(x.offlineDailyCap),
        rupees(x.legacyBalance),
        phones(x.code),
      ]),
    },
    {
      file: 'parties/no-phone.csv',
      title: 'Parties without a phone',
      why: 'Contact clean-up.',
      header: ['Code', 'Name'],
      rows: f.parties.noPhone.map((x) => [x.code, x.name]),
    },
    {
      file: 'parties/both-roles.csv',
      title: 'Parties that are customer and supplier',
      why: 'One party with two accounts; check.',
      header: ['Code', 'Name', 'Phones'],
      rows: f.parties.bothRoles.map((x) => [x.code, x.name, phones(x.code)]),
    },
    {
      file: 'parties/abbreviation-clashes.csv',
      title: 'Label abbreviations used by several parties',
      why: 'Labels print the abbreviation (D-019); make them unique.',
      header: ['Abbreviation', 'Parties'],
      rows: f.parties.abbreviationClashes.map((x) => [x.abbr, x.parties.join(' ')]),
    },
    {
      file: 'unused-tables.csv',
      title: 'Staged tables the import does not read',
      why: 'Expected for the old app settings; anything else needs a rule.',
      header: ['Table'],
      rows: r.unusedTables.map((t) => [t]),
    },
  ];
}

/** Writes `<labelDir>/reports/`: index.html, summary.json (counts only) and the CSVs. Returns the index path. */
export async function writeImportReports(r: ImportResult, labelDir: string): Promise<string> {
  const dir = join(labelDir, 'reports');
  const reports = reportsOf(r);
  for (const rep of reports) {
    const path = join(dir, rep.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, csv(rep.header, rep.rows));
  }
  const summary = {
    label: r.label,
    dryRun: r.dryRun,
    groups: r.groups,
    findings: Object.fromEntries(reports.map((rep) => [rep.file, rep.rows.length])),
  };
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  // The shop's own details, to propose the bill header from (owner answer 2).
  const cell = (v: string) => v.replace(/\|/g, '/');
  await writeFile(
    join(dir, 'company.md'),
    [
      `# Company details (${r.label})`,
      '',
      'From the legacy company settings, for the bill header. No customer data, no credentials.',
      '',
      '| Field | Value |',
      '|---|---|',
      ...r.company.map((c) => `| ${cell(c.field)} | ${cell(c.value)} |`),
      '',
    ].join('\n'),
  );
  const groupRows = GROUPS.map((g) => {
    const c = r.groups[g];
    return `<tr><td>${g}</td><td>${c.created}</td><td>${c.updated}</td><td>${c.unchanged}</td><td>${c.retired}</td></tr>`;
  }).join('');
  const reportRows = reports
    .map(
      (rep) =>
        `<tr><td><a href="${rep.file}">${html(rep.title)}</a></td><td>${rep.rows.length}</td><td>${html(rep.why)}</td></tr>`,
    )
    .join('');
  const index = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Legacy import: ${html(r.label)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;max-width:1000px}table{border-collapse:collapse;margin:12px 0 24px}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:start}td:nth-child(n+2){font-variant-numeric:tabular-nums}</style></head>
<body><h1>Legacy import: ${html(r.label)}${r.dryRun ? ' (dry run: nothing written)' : ''}</h1>
<h2>What was loaded</h2><table><tr><th>Group</th><th>Created</th><th>Updated</th><th>Unchanged</th><th>Retired</th></tr>${groupRows}</table>
<h2>For your review</h2><p>Each file opens in Excel. Decisions go into <code>tools/legacy-import/mapping/delux.json</code>; then run the import again.</p>
<table><tr><th>Report</th><th>Rows</th><th>What to do</th></tr>${reportRows}</table></body></html>
`;
  await writeFile(join(dir, 'index.html'), index);
  return join(dir, 'index.html');
}
