import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import {
  money,
  type CashMovementDocument,
  type CashSessionDocument,
  type CustomerCollectionDocument,
} from '@erp/domain';

import { i18n } from '../i18n';
import { DeskSlipPrint, type DeskPrintJob, type DeskSlip } from './DeskSlipPrint';

// The desk's printed slips (W1-11, owner answer 5): what each shows, black on white like the bill.

const job = (slip: DeskSlip): DeskPrintJob => ({
  slip,
  profile: null,
  shopName: 'Delux Autos',
  headerLines: ['Plaza Market, Karachi'],
  cashierName: 'Ali',
  money: { locale: 'en-PK', currency: 'PKR', minorUnits: 2 },
  timeZone: 'Asia/Karachi',
  reprint: null,
});
const show = (slip: DeskSlip) =>
  render(
    <I18nextProvider i18n={i18n}>
      <DeskSlipPrint job={job(slip)} />
    </I18nextProvider>,
  );
const common = { createdAt: '2026-11-02T10:30:00.000Z', note: null, reference: null };

describe('the desk slips', () => {
  // W2-19: the same page as a bill: the margin inside the page, and a white page.
  it('keep their 8 mm margin inside the page and print on a white page, like a bill', () => {
    const { container, unmount } = render(
      <I18nextProvider i18n={i18n}>
        <DeskSlipPrint
          job={job({
            kind: 'collection',
            doc: {
              ...common,
              number: 'D01-R000002',
              customerName: 'Ali Autos',
              customerCode: 'C0042',
              amount: money(100000),
              balanceBefore: money(100000),
            } as CustomerCollectionDocument,
            methodName: 'Cash',
            balanceAfter: 0,
          })}
        />
      </I18nextProvider>,
    );
    // This file's other tests find their slip by its words: leave none behind, even when this one fails.
    try {
      const style = container.querySelector('style')!.textContent;
      expect(style).toMatch(/@page \{[^}]*margin: 0;/);
      expect(style).toMatch(/\.bill-page \{[^}]*padding: 8mm;/);
      expect(style).toContain('@media print { html, body { background: #fff !important;');
    } finally {
      unmount();
    }
  });

  it('a receipt shows the customer, the amount, the method and the balance before and after', () => {
    show({
      kind: 'collection',
      doc: {
        ...common,
        number: 'D01-R000001',
        customerName: 'Ali Autos',
        customerCode: 'C0042',
        amount: money(500000),
        balanceBefore: money(1250000),
        reference: 'TX-1',
      } as CustomerCollectionDocument,
      methodName: 'Raast',
      balanceAfter: 750000,
    });
    expect(screen.getByText('PAYMENT RECEIPT')).toBeTruthy();
    expect(screen.getByText('Ali Autos (C0042)')).toBeTruthy();
    expect(screen.getByText('Raast · TX-1')).toBeTruthy();
    expect(screen.getByText(/7,500/)).toBeTruthy();
    expect(screen.queryByText(/signature/)).toBeNull();
  });

  it('a voucher shows what it was for and a line for the receiver to sign', () => {
    show({
      kind: 'cash_out',
      doc: {
        ...common,
        number: 'D01-M000004',
        kind: 'supplier_payment',
        targetName: 'Addi Traders',
        amount: money(800000),
        note: 'runner Bilal',
      } as CashMovementDocument,
    });
    expect(screen.getByText('CASH VOUCHER')).toBeTruthy();
    expect(screen.getByText('Supplier payment')).toBeTruthy();
    expect(screen.getByText('Addi Traders')).toBeTruthy();
    expect(screen.getByText('Received by (signature)')).toBeTruthy();
  });

  it('a close slip shows the count by note, the variance, what stayed and who is to acknowledge', () => {
    show({
      kind: 'close',
      doc: {
        ...common,
        number: 'D01-Z000007',
        denominations: { '500000': 2, '100000': 0, '10000': 3 },
        countedCash: money(1030000),
        expectedCash: money(1060000),
        variance: money(-30000),
        varianceReason: 'change_error',
        varianceNote: null,
        leftInDrawer: money(500000),
      } as unknown as CashSessionDocument,
      acknowledgedByName: null,
      toSafe: 530000,
    });
    expect(screen.getByText('DRAWER CLOSE')).toBeTruthy();
    expect(screen.getByText(/5,000.* × 2/)).toBeTruthy();
    expect(screen.queryByText(/1,000.* × 0/)).toBeNull();
    expect(screen.getByText('Wrong change given')).toBeTruthy();
    expect(screen.getByText('to acknowledge')).toBeTruthy();
  });
});
