import type { CashMovementDocument, CashSessionDocument, CustomerCollectionDocument } from '@erp/domain';
import { formatMoney, type MoneyFormat } from '@erp/ui';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';

import type { PrintProfile } from '../db/checkout';
import { i18n } from '../i18n';
import { pageStyle } from './page-style';

// The desk's printed slips (CSH-05, CSH-06, CSH-07, owner answer 5 to W1-11): the collection receipt handed to the
// customer, the cash-out voucher the receiver signs, and the close slip the cashier and manager sign. Black on white
// like the bill (POS spec §13), on the desk's print profile page; printed after the document is committed, so a failed
// print never changes it.

export type DeskSlip =
  | {
      kind: 'collection';
      doc: CustomerCollectionDocument;
      methodName: string;
      /** The desk's balance after it, as of the last sync. */
      balanceAfter: number;
    }
  | { kind: 'cash_out'; doc: CashMovementDocument }
  | { kind: 'close'; doc: CashSessionDocument; acknowledgedByName: string | null; toSafe: number };

export interface DeskPrintJob {
  slip: DeskSlip;
  profile: PrintProfile | null;
  shopName: string;
  headerLines: string[];
  cashierName: string;
  money: MoneyFormat;
  timeZone: string;
  /** A reprint carries a band with when and who, like a bill's. */
  reprint: { at: string; by: string } | null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SlipPage({ job }: { job: DeskPrintJob }) {
  const { t } = useTranslation();
  const m = (minor: number) => formatMoney(minor, job.money);
  const time = (iso: string) =>
    new Intl.DateTimeFormat(job.money.locale, {
      timeZone: job.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  const s = job.slip;
  const doc = s.doc;
  const title =
    s.kind === 'collection'
      ? t('print.desk.receipt')
      : s.kind === 'cash_out'
        ? t('print.desk.voucher')
        : t('print.desk.closeSlip');

  return (
    <article className="bill-page">
      <header className="bill-head">
        <h1>{job.shopName}</h1>
        {job.headerLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <h2>{title}</h2>
        {job.reprint && (
          <p className="bill-reprint" data-testid="reprint-band">
            {t('print.reprint', { at: time(job.reprint.at), by: job.reprint.by })}
          </p>
        )}
      </header>
      <dl className="bill-meta">
        <Row label={t('print.number')} value={doc.number} />
        <Row label={t('print.date')} value={time(doc.createdAt)} />
        <Row label={t('print.desk.cashier')} value={job.cashierName} />
      </dl>
      <dl className="bill-totals desk-slip">
        {s.kind === 'collection' && (
          <>
            <Row label={t('print.customer')} value={`${s.doc.customerName} (${s.doc.customerCode})`} />
            <div className="bill-total">
              <dt>{t('print.desk.received')}</dt>
              <dd>{m(s.doc.amount)}</dd>
            </div>
            <Row
              label={t('print.desk.method')}
              value={s.doc.reference === null ? s.methodName : `${s.methodName} · ${s.doc.reference}`}
            />
            <Row label={t('print.desk.balanceBefore')} value={m(s.doc.balanceBefore)} />
            <Row label={t('print.desk.balanceAfter')} value={m(s.balanceAfter)} />
            {s.doc.note && <Row label={t('print.desk.note')} value={s.doc.note} />}
          </>
        )}
        {s.kind === 'cash_out' && (
          <>
            <Row label={t('print.desk.kind')} value={t(`desk.cashOut.kind.${s.doc.kind}`)} />
            {s.doc.targetName && <Row label={t('print.desk.to')} value={s.doc.targetName} />}
            {s.doc.billNumber && <Row label={t('print.desk.bill')} value={s.doc.billNumber} />}
            <div className="bill-total">
              <dt>{t('print.desk.paid')}</dt>
              <dd>{m(s.doc.amount)}</dd>
            </div>
            {s.doc.note && <Row label={t('print.desk.note')} value={s.doc.note} />}
            {s.doc.reference && <Row label={t('print.desk.reference')} value={s.doc.reference} />}
          </>
        )}
        {s.kind === 'close' && (
          <>
            {Object.entries(s.doc.denominations ?? {})
              .filter(([, count]) => count > 0)
              .sort(([a], [b]) => Number(b) - Number(a))
              .map(([d, count]) => (
                <Row key={d} label={`${m(Number(d))} × ${count}`} value={m(Number(d) * count)} />
              ))}
            <div className="bill-total">
              <dt>{t('print.desk.counted')}</dt>
              <dd>{m(s.doc.countedCash ?? 0)}</dd>
            </div>
            <Row label={t('print.desk.expected')} value={m(s.doc.expectedCash ?? 0)} />
            <Row label={t('print.desk.variance')} value={m(s.doc.variance ?? 0)} />
            {s.doc.varianceReason && (
              <Row label={t('print.desk.reason')} value={t(`desk.count.reason.${s.doc.varianceReason}`)} />
            )}
            {s.doc.varianceNote && <Row label={t('print.desk.note')} value={s.doc.varianceNote} />}
            <Row label={t('print.desk.left')} value={m(s.doc.leftInDrawer ?? 0)} />
            <Row label={t('print.desk.toSafe')} value={m(s.toSafe)} />
            {s.doc.variance !== 0 && (
              <Row
                label={t('print.desk.acknowledged')}
                value={s.acknowledgedByName ?? t('print.desk.toAcknowledge')}
              />
            )}
          </>
        )}
      </dl>
      {s.kind !== 'collection' && (
        <p className="desk-sign">
          {s.kind === 'cash_out' ? t('print.desk.receiverSigns') : t('print.desk.cashierSigns')}
        </p>
      )}
    </article>
  );
}

export function DeskSlipPrint({ job }: { job: DeskPrintJob }) {
  const page = (job.profile?.paperFormat ?? 'a5') === 'a5' ? 'a5' : 'a4';
  return (
    <div className="bill-print" data-page={page}>
      <style>{pageStyle(page)}</style>
      <SlipPage job={job} />
    </div>
  );
}

const HOST_ID = 'print-root';

/** Prints a slip like a bill (print-bill.tsx): rendered into the print-only container, then window.print(). */
export function printDeskSlip(job: DeskPrintJob): void {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.append(host);
  }
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <DeskSlipPrint job={job} />
      </I18nextProvider>,
    ),
  );
  try {
    window.print();
  } finally {
    root.unmount();
  }
}
