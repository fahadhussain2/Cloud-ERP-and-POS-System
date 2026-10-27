import { z } from 'zod';

// Documents a device writes to its outbox and pushes (sync spec §6). The device signs canonicalJson(document).

/**
 * A finalized sale, version 1 (sync spec §6.1, W1-06): what `buildSaleDocument` in `@erp/domain` makes and what the
 * server accepts in W1-07. Money is whole minor units, quantities thousandths.
 */
// Not built yet (W1-06): refuses everything until the schema is written.
export const SaleDocumentV1 = z.never();
export type SaleDocumentV1 = z.infer<typeof SaleDocumentV1>;
