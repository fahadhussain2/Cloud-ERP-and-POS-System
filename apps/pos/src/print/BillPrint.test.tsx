import { buildSaleDocument, type Bill, type Money, type Qty } from '@erp/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PrintProfile } from '../db/checkout';
import { i18n } from '../i18n';
import en from '../locales/en.json';
import { BillPrint } from './BillPrint';
import { printBill } from './print-bill';
import type { PrintJob } from './print-job';

// The printed sale bill (POS spec §13, POS-09): what it shows, the REPRINT band, the page size and copies, and that
// printing renders it before window.print() and clears it after.

const METHODS = [
  { code: 'cash', isCash: true, requiresReference: false },
  { code: 'jazzcash', isCash: false, requiresReference: true },
] as const;

const bill: Bill = {
  version: 1,
  sellerId: '019a0000-0000-7000-8000-0000000000a1',
  tierId: '019a0000-0000-7000-8000-0000000000b1',
  lines: [
    {
      id: 'l1',
      itemId: 'i-brpd',
      qty: 1000 as Qty,
      allowsFraction: false,
      list: 450000 as Money,
      floor: 400000 as Money,
      unitPrice: 450000 as Money,
      approval: null,
    },
    {
      id: 'l2',
      itemId: 'i-hose',
      qty: 1500 as Qty,
      allowsFraction: true,
      list: 33300 as Money,
      floor: null,
      unitPrice: 33300 as Money,
      approval: null,
    },
  ],
  billDiscount: 0 as Money,
  billApproval: null,
};

// Rs 4,500 + 1.5 m × Rs 333 = Rs 4,999.50, rounded to Rs 5,000; Rs 3,000 cash (Rs 5,000 handed over) + Rs 2,000 JazzCash.
const document = buildSaleDocument({
  bill,
  tender: {
    payments: [
      { method: 'cash', amount: 300000 as Money, reference: null },
      { method: 'jazzcash', amount: 200000 as Money, reference: 'JC-1' },
    ],
    cashReceived: 500000 as Money,
  },
  methods: METHODS,
  sellerMaxDiscountBp: 0,
  customer: { id: null, walkinPhone: null },
  credit: null,
  creditApproval: null,
  context: {
    id: '019a3f6e-7b10-7c3a-9d2e-5b8f1a2c3d4e',
    seq: 412,
    deviceId: '019a0000-0000-7000-8000-0000000000d1',
    deviceCode: 'C03',
    branchId: '019a0000-0000-7000-8000-0000000000e1',
    createdAtMs: Date.parse('2026-11-02T10:15:30.000Z'),
    timeZone: 'Asia/Karachi',
    cutoffHour: 4,
    increment: 100 as Money,
    clientVersion: '0.6.0',
  },
});

const A4: PrintProfile = {
  id: 'p4',
  name: 'A4 laser',
  paperFormat: 'a4',
  codeType: 'barcode',
  copies: 2,
  headerLines: [],
  policyText: 'No returns on electrical parts.',
};

const job = (over: Partial<PrintJob> = {}): PrintJob => ({
  document,
  profile: null,
  shopName: 'Delux Autos',
  headerLines: ['Shop 14, Auto Market', '021-1234567'],
  items: {
    'i-brpd': { code: 'BRPD001', name: 'BRAKE PADS FRONT COROLLA' },
    'i-hose': { code: 'HOSE001', name: 'FUEL HOSE' },
  },
  sellerName: 'Sara',
  customer: null,
  methodNames: { cash: 'Cash', jazzcash: 'JazzCash' },
  money: { locale: 'en-PK', currency: 'PKR', minorUnits: 2 },
  timeZone: 'Asia/Karachi',
  reprint: null,
  ...over,
});

const show = (j: PrintJob) =>
  render(
    <I18nextProvider i18n={i18n}>
      <BillPrint job={j} />
    </I18nextProvider>,
  );
const plain = (s: string | null | undefined) => (s ?? '').replaceAll(String.fromCharCode(160), ' ');

afterEach(cleanup);

describe('the printed bill', () => {
  it('shows the shop, the bill, its lines, totals with rounding, payments with references, cash and change', () => {
    const { container } = show(job());
    const text = plain(container.textContent);
    for (const expected of [
      'Delux Autos',
      'Shop 14, Auto Market',
      '021-1234567',
      en.print.saleBill,
      'C03-S000412',
      'Sara',
      en.print.walkIn,
      'BRPD001',
      'BRAKE PADS FRONT COROLLA',
      'HOSE001',
      'FUEL HOSE',
      `${en.print.subtotal}Rs 4,999.50`,
      `${en.print.rounding}Rs 0.50`,
      `${en.print.total}Rs 5,000`,
      `Cash${'Rs 3,000'}`,
      'JazzCash · JC-1Rs 2,000',
      `${en.print.cashReceived}Rs 5,000`,
      `${en.print.change}Rs 2,000`,
      en.print.policy,
    ])
      expect(text).toContain(expected);
    // Date and time in the tenant's zone: 10:15 UTC is 3:15 pm in Karachi.
    expect(text).toMatch(/02-Nov-2026, 3:15 pm/i);
    const rows = [...container.querySelectorAll('tbody tr')].map((r) => plain(r.textContent));
    expect(rows).toEqual([
      '1BRPD001BRAKE PADS FRONT COROLLA1Rs 4,500Rs 4,500',
      '2HOSE001FUEL HOSE1.5Rs 333Rs 499.50',
    ]);
    expect(screen.queryByTestId('reprint-band')).toBeNull();
  });

  it('carries the bill code as bars and as text: the number and the cash due in whole rupees', () => {
    const { container } = show(job());
    expect(screen.getByTestId('bill-code').textContent).toBe('C03-S000412 3000');
    expect(container.querySelectorAll('.bill-bars svg rect').length).toBeGreaterThan(50);
  });

  // W2-19 (owner's scan test, 2026-11-28): the bars were squeezed into 62 mm, 0.2 mm wide, too thin to scan.
  it('draws the bill code with bars of 1/75 inch, the barcode as wide as its code needs', () => {
    const { container } = show(job());
    const svg = container.querySelector('.bill-bars svg')!;
    // 'C03-S000412 3000': 18 characters with start and stop, 280 narrow widths of 0.339 mm.
    expect(svg.getAttribute('width')).toBe('94.827mm');
    expect(svg.getAttribute('height')).toBe('11mm');
    const widths = [...svg.querySelectorAll('rect')].map((r) => Number(r.getAttribute('width')));
    expect(Math.min(...widths)).toBe(0.339);
    expect(Math.max(...widths)).toBe(0.847);
    cleanup();
    // A bigger cash due is a longer code: a wider barcode, never thinner bars.
    const big = show(job({ document: { ...document, cashDue: 12_500_000 as Money } }));
    const wide = big.container.querySelector('.bill-bars svg')!;
    expect(Number(wide.getAttribute('width')!.replace('mm', ''))).toBeGreaterThan(94.827);
    expect(Math.min(...[...wide.querySelectorAll('rect')].map((r) => Number(r.getAttribute('width'))))).toBe(
      0.339,
    );
  });

  it('keeps its 8 mm margin inside each page, whatever the print dialog says, and prints on a white page', () => {
    const style = show(job()).container.querySelector('style')!.textContent;
    expect(style).toMatch(/@page \{[^}]*margin: 0;/);
    expect(style).toMatch(/\.bill-page \{[^}]*padding: 8mm;[^}]*box-decoration-break: clone;/);
    expect(style).toMatch(
      /@media print \{ html, body \{ background: #fff !important; color: #000 !important; \} \}/,
    );
  });

  it('has no discount line without a bill discount, and only i18n text', () => {
    const { container } = show(job());
    const text = container.textContent ?? '';
    expect(text).not.toContain(en.print.discount);
    expect(text).not.toMatch(/print\.\w/);
  });

  it("prints a customer's name and code instead of Walk-in, never their phone or balance (W1-09)", () => {
    const { container } = show(job({ customer: { code: 'C0042', name: 'Khan Motors' } }));
    const text = plain(container.textContent);
    expect(text).toContain('Khan Motors (C0042)');
    expect(text).not.toContain(en.print.walkIn);
  });

  it('a reprint carries the REPRINT band with when and who', () => {
    show(job({ reprint: { at: '2026-11-02T11:00:00.000Z', by: 'Asif Khan' } }));
    expect(plain(screen.getByTestId('reprint-band').textContent)).toMatch(
      /^REPRINT · 02-Nov-2026, 4:00 pm · Asif Khan$/i,
    );
  });

  it('A5 landscape by default; an A4 profile with 2 copies prints two A4 pages with its policy line', () => {
    const a5 = show(job());
    expect(a5.container.querySelector('style')?.textContent).toContain('size: A5 landscape');
    expect(a5.container.querySelectorAll('.bill-page')).toHaveLength(1);
    cleanup();
    const a4 = show(job({ profile: A4 }));
    expect(a4.container.querySelector('style')?.textContent).toContain('size: A4 portrait');
    expect(a4.container.querySelectorAll('.bill-page')).toHaveLength(2);
    expect(a4.container.textContent).toContain('No returns on electrical parts.');
  });

  it('thermal profiles print the A4 layout until thermal templates are built', () => {
    const { container } = show(job({ profile: { ...A4, paperFormat: 'thermal_80', copies: 1 } }));
    expect(container.querySelector('style')?.textContent).toContain('size: A4 portrait');
  });
});

describe('printBill', () => {
  it('renders the bill into the print container before window.print(), and clears it after', () => {
    let printed = '';
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printed = window.document.getElementById('print-root')?.textContent ?? '';
    });
    printBill(job());
    expect(print).toHaveBeenCalledTimes(1);
    expect(printed).toContain('C03-S000412');
    expect(window.document.getElementById('print-root')?.textContent).toBe('');
    print.mockRestore();
  });
});
