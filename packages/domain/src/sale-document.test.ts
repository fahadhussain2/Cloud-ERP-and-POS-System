import billCodeCases from '../golden/bill-code.json';
import numberCases from '../golden/document-number.json';
import saleDocumentCases from '../golden/sale-document.json';
import saleTotalCases from '../golden/sale-total.json';
import type { Bill } from './bill';
import { money } from './money';
import {
  billCode,
  buildSaleDocument,
  documentNumber,
  parseBillCode,
  saleTotal,
  type DocumentFamily,
} from './sale-document';
import type { Tender } from './tender';
import { runGolden, type GoldenFile } from './testing/golden';
import { DELUX_METHODS } from './testing/methods';

// Bills and tenders go in as they are: the JSON numbers are already whole minor units and thousandths.
const RS = money(100);

runGolden(saleTotalCases as unknown as GoldenFile<{ bill: Bill; increment: number }>, (i) =>
  saleTotal(i.bill, money(i.increment)),
);

runGolden(numberCases as GoldenFile<{ deviceCode: string; family: DocumentFamily; seq: number }>, (i) =>
  documentNumber(i.deviceCode, i.family, i.seq),
);

runGolden(
  billCodeCases as GoldenFile<{ encode?: { number: string; cashDue: number }; parse?: string }>,
  (i) =>
    i.encode !== undefined
      ? billCode({ number: i.encode.number, cashDue: money(i.encode.cashDue) }, RS)
      : parseBillCode(i.parse!, RS),
);

// The fixed part of every case's context (see the golden file's description).
const COUNTER = {
  deviceId: '019a0000-0000-7000-8000-0000000000d1',
  deviceCode: 'C03',
  branchId: '019a0000-0000-7000-8000-0000000000e1',
  timeZone: 'Asia/Karachi',
  cutoffHour: 4,
  increment: RS,
  clientVersion: '0.6.0',
};

runGolden(
  saleDocumentCases as unknown as GoldenFile<{
    bill: Bill;
    tender: Tender;
    sellerMaxDiscountBp: number;
    context: { id: string; seq: number; createdAtMs: number };
  }>,
  (i) =>
    buildSaleDocument({
      bill: i.bill,
      tender: i.tender,
      methods: DELUX_METHODS,
      sellerMaxDiscountBp: i.sellerMaxDiscountBp,
      hasCreditCustomer: false,
      context: { ...COUNTER, ...i.context },
    }),
);
