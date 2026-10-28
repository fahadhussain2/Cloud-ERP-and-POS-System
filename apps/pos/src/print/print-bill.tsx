import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import { i18n } from '../i18n';
import { BillPrint } from './BillPrint';
import type { PrintJob } from './print-job';

// Printing (POS spec §13, architecture §8): the bill is rendered into a print-only container and printed with
// window.print(). The counter's browser runs with --kiosk-printing, so it goes to the default Windows printer with no
// dialog. Called only after the bill is committed: a failed print never changes the bill, and Alt+P reprints it.

const HOST_ID = 'print-root';

export function printBill(job: PrintJob): void {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.append(host);
  }
  const root = createRoot(host);
  // Rendered before print() is called: the browser prints what the page shows at that moment.
  flushSync(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <BillPrint job={job} />
      </I18nextProvider>,
    ),
  );
  try {
    window.print();
  } finally {
    root.unmount();
  }
}
