# Domain Glossary

| Term | Meaning |
|---|---|
| **Counter** | A POS device where a salesman sells and prints bills |
| **Cash desk** | The single device with the cash drawer. It sells **and** receives handovers, pays refunds, takes collections and closes the drawer. |
| **Handover** | The salesman brings a bill's cash to the cash desk; the cashier confirms it from the live queue, or scans the bill code (always when offline). Tenant setting `cash_handover_mode`: Required (Delux) or Off (automatic). |
| **Cash in transit** | GL account holding cash from finalized counter bills not yet handed over. It must be 0 after a fully synced day. |
| **Day close** | The cashier's end-of-day routine: count the drawer by note, compare it with the expected cash, record the variance, close the cash session. |
| **Business date** | Local date with a 04:00 cutoff (the shop closes at 20:00; late sales count to the same day) |
| **Print profile** | Per-tenant/per-device bill printing setup: paper format, bill code (barcode or signed QR), copies. Delux: shared network dot matrix, A5 landscape, Code 39 barcode. |
| **Floor price** | Lowest price allowed without a manager PIN |
| **Tier** | Price list (Retail / Mechanic / Wholesale) |
| **Override** | A manager's PIN approval recorded on a document (below floor, credit limit, void, no-receipt return, missing permission) |
| **Shop / Godown / Damaged** | Stock locations: sellable / storage / not sellable |
| **Goods receipt** | Receiving stock together with the supplier's bill (purchase invoice) |
| **PO** | Purchase order: draft → sent → partly received → received (or cancelled) |
| **Party** | Customer and/or supplier |
| **Offline daily cap** | Maximum a credit customer can buy on account per day from a counter that is offline |
| **Exception** | A rule break the server accepted and flagged for review (e.g. below floor without override, missing handover) |
| **Outbox** | A device's queue of finalized documents waiting to be pushed to the server |
| **Trial balance** | Every account's opening, movement and closing, debit and credit, for a period; debits equal credits at every level (W2-01) |
| **Day book** | Every journal voucher posted in a period, in posting order, with its lines (RPT-11) |
| **Cash book** | Each cash and bank account (drawer, cash in transit, safe, banks and wallets) by day: opening, money in, money out, closing (ACC-07) |
| **Profit for the year** | Income − expenses from the start of the fiscal year to a date, shown in equity on the balance sheet; worked out from the books, never posted (no closing entry until the first year end) |
| **Wave** | A build-order block of the MVP (Wave 0 foundations, Wave 1 critical path, Wave 2 rest of MVP) |
