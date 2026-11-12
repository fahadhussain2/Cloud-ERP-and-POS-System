import { billCode, isReturnedLine, money as toMoney, sub, sum } from '@erp/domain';
import { code39Svg } from '@erp/print';
import { formatMoney } from '@erp/ui';
import { useTranslation } from 'react-i18next';

import { formatQty } from '../bill/bill-state';
import type { PrintJob } from './print-job';

// The printed sale bill (POS spec §13, POS-09, the prototype's layout): black on white, no shading, A5 landscape
// (Delux, owner answer 1) or A4 portrait. Thermal formats print the A4 layout until their templates are built
// (owner answer 2). A return or exchange (W1-13, POS spec §19) prints as RETURN or EXCHANGE, its returned lines first
// with their reason and condition, and what happens to the refund. Text through i18n keys, logical CSS (rule 10).

/** The page a profile prints on. */
export const pageOf = (job: PrintJob): 'a5' | 'a4' =>
  (job.profile?.paperFormat ?? 'a5') === 'a5' ? 'a5' : 'a4';

/** The barcode text, or null when the cash due can't be carried (paisa: never at Delux, which rounds to Rs 1). */
function codeText(job: PrintJob): string | null {
  try {
    return billCode(
      { number: job.document.number, cashDue: job.document.cashDue },
      toMoney(10 ** job.money.minorUnits),
    );
  } catch {
    return null;
  }
}

function BillPage({ job }: { job: PrintJob }) {
  const { t } = useTranslation();
  const d = job.document;
  const m = (minor: number) => formatMoney(minor, job.money);
  const time = (iso: string) =>
    new Intl.DateTimeFormat(job.money.locale, {
      timeZone: job.timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  const amounts = d.lines.map((l) => l.lineTotal + l.billShare);
  const returned = d.version === 2 ? d.lines.filter(isReturnedLine) : [];
  // The subtotal is the sold lines; the refunds are their own row.
  const linesTotal = sum(amounts.filter((a) => a > 0).map((a) => toMoney(a)));
  const returnTotal = d.version === 2 ? d.amounts.returnTotal : 0;
  const cash = d.payments.find((p) => p.changeDue !== null);
  const refund = d.payments.find((p) => p.amount < 0);
  const title =
    d.kind === 'return'
      ? 'print.returnBill'
      : d.kind === 'exchange'
        ? 'print.exchangeBill'
        : 'print.saleBill';
  const code = codeText(job);
  const policy = job.profile?.policyText ?? t('print.policy');

  return (
    <article className="bill-page">
      <header className="bill-head">
        <h1>{job.shopName}</h1>
        {job.headerLines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <h2>{t(title)}</h2>
        {d.version === 2 && (
          <p className="bill-return-of" data-testid="return-of">
            {d.returnOf
              ? t('print.returnedFrom', {
                  number: d.returnOf.number,
                  date: new Intl.DateTimeFormat(job.money.locale, {
                    dateStyle: 'medium',
                    timeZone: 'UTC',
                  }).format(new Date(`${d.returnOf.businessDate}T00:00:00Z`)),
                })
              : d.noReceipt?.ref
                ? t('print.noReceiptRef', { ref: d.noReceipt.ref })
                : t('print.noReceipt')}
          </p>
        )}
        {job.voided && (
          <p className="bill-void" data-testid="void-band">
            {t('print.void', {
              number: job.voided.number,
              at: time(job.voided.at),
              by: job.voided.by,
              approvedBy: job.voided.approvedBy,
              reason: job.voided.reason,
            })}
          </p>
        )}
        {d.version === 1 && d.reissueOf && (
          <p className="bill-reissue">{t('print.reissueOf', { number: d.reissueOf.number })}</p>
        )}
        {job.reprint && (
          <p className="bill-reprint" data-testid="reprint-band">
            {t('print.reprint', { at: time(job.reprint.at), by: job.reprint.by })}
          </p>
        )}
      </header>
      <dl className="bill-meta">
        <div>
          <dt>{t('print.number')}</dt>
          <dd>{d.number}</dd>
        </div>
        <div>
          <dt>{t('print.date')}</dt>
          <dd>{time(d.createdAt)}</dd>
        </div>
        <div>
          <dt>{t('print.counter')}</dt>
          <dd>{d.number.split('-')[0]}</dd>
        </div>
        <div>
          <dt>{t('print.salesman')}</dt>
          <dd>{job.sellerName}</dd>
        </div>
        <div>
          <dt>{t('print.customer')}</dt>
          <dd>{job.customer ? `${job.customer.name} (${job.customer.code})` : t('print.walkIn')}</dd>
        </div>
      </dl>
      <table className="bill-lines">
        <thead>
          <tr>
            <th>{t('print.head.no')}</th>
            <th>{t('print.head.code')}</th>
            <th className="bill-wide">{t('print.head.description')}</th>
            <th className="bill-num">{t('print.head.qty')}</th>
            <th className="bill-num">{t('print.head.rate')}</th>
            <th className="bill-num">{t('print.head.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={l.lineNo}>
              <td>{l.lineNo}</td>
              <td>{job.items[l.itemId]?.code ?? ''}</td>
              <td className="bill-wide">
                {job.items[l.itemId]?.name ?? l.itemId}
                {isReturnedLine(l) && (
                  <span className="bill-returned">
                    {' · '}
                    {t('print.returnedLine', {
                      reason: t(`return.reason.${l.reason}`),
                      condition: t(`return.condition.${l.condition}`),
                    })}
                  </span>
                )}
              </td>
              <td className="bill-num">{formatQty(l.qty, job.money.locale)}</td>
              <td className="bill-num">{m(l.unitPrice)}</td>
              <td className="bill-num">{m(amounts[i]!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="bill-foot">
        <div className="bill-code">
          {code !== null && (
            <>
              {/* Bars drawn by packages/print: no barcode font is needed on the counter. */}
              <div
                className="bill-bars"
                dangerouslySetInnerHTML={{
                  __html: code39Svg(code, { narrow: 1, wide: 2.5, height: 40, quiet: 10 }),
                }}
              />
              <p data-testid="bill-code">{code}</p>
            </>
          )}
          <p className="bill-policy">{policy}</p>
        </div>
        <dl className="bill-totals">
          <div>
            <dt>{t('print.subtotal')}</dt>
            <dd>{m(linesTotal)}</dd>
          </div>
          {returned.length > 0 && (
            <div>
              <dt>{t('print.returned')}</dt>
              <dd>{m(sub(toMoney(0), toMoney(returnTotal)))}</dd>
            </div>
          )}
          {d.amounts.billDiscount !== 0 && (
            <div>
              <dt>{t('print.discount')}</dt>
              <dd>{m(sub(toMoney(0), d.amounts.billDiscount))}</dd>
            </div>
          )}
          {d.amounts.rounding !== 0 && (
            <div>
              <dt>{t('print.rounding')}</dt>
              <dd>{m(d.amounts.rounding)}</dd>
            </div>
          )}
          <div className="bill-total">
            <dt>{t('print.total')}</dt>
            <dd>{m(d.amounts.total)}</dd>
          </div>
          {d.payments.map((p) => (
            <div key={p.method}>
              <dt>
                {job.methodNames[p.method] ?? p.method}
                {p.reference && ` · ${p.reference}`}
              </dt>
              <dd>{m(p.amount)}</dd>
            </div>
          ))}
          {refund && (
            <div className="bill-total" data-testid="refund">
              <dt>
                {refund.method === 'cash'
                  ? t('print.refundAtDesk', { amount: m(sub(toMoney(0), refund.amount)) })
                  : refund.method === 'on_account'
                    ? t('print.creditedToAccount')
                    : t('print.refundedBy', { method: job.methodNames[refund.method] ?? refund.method })}
              </dt>
              <dd>{m(sub(toMoney(0), refund.amount))}</dd>
            </div>
          )}
          {cash && (
            <>
              <div>
                <dt>{t('print.cashReceived')}</dt>
                <dd>{m(cash.cashReceived ?? cash.amount)}</dd>
              </div>
              <div className="bill-total">
                <dt>{t('print.change')}</dt>
                <dd>{m(cash.changeDue ?? 0)}</dd>
              </div>
            </>
          )}
        </dl>
      </div>
    </article>
  );
}

/** Every copy of the bill, one page each, with the page size of the profile. */
export function BillPrint({ job }: { job: PrintJob }) {
  const page = pageOf(job);
  const copies = job.profile?.copies ?? 1;
  return (
    <div className="bill-print" data-page={page}>
      <style>{`@page { size: ${page === 'a5' ? 'A5 landscape' : 'A4 portrait'}; margin: 8mm; }`}</style>
      {Array.from({ length: copies }, (_, i) => (
        <BillPage key={i} job={job} />
      ))}
    </div>
  );
}
