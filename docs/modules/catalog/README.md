# Catalog and pricing (`CAT`)

| | |
|---|---|
| **Status** | Not started (build on hold, D-068) |
| **Requirements** | 9 (CAT-01…CAT-09) |
| **Feature spec needed** | No: the PRD and data model are enough |

## Scope

Items, identifiers (barcode / OEM / alternate), vehicle tags, price tiers, floor prices, markup rules, price history, labels, CSV import.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| CAT-01 | Item: code (unique, scannable), name, category, brand, origin, unit, position/variant (L/R/Front/Rear/Set…), bin location, default supplier, min and max… | 1 |
| CAT-02 | Multiple identifiers per item: barcodes, OEM part numbers, alternate or supplier references. | 1 |
| CAT-03 | Optional vehicle tags per item: make, model, year range, free-text note. | 1 |
| CAT-04 | Price tiers per tenant (default Retail / Mechanic / Wholesale). | 1 |
| CAT-05 | Floor price per item, or a category rule (floor = cost × (1 + min margin)). | 1 |
| CAT-06 | Category markup rules for repricing suggestions (tier prices and floor from cost). | 2 |
| CAT-07 | Price change history (who, when, old → new, reason/source). | 1 |
| CAT-08 | Label printing in the legacy format (Code 39 item code (D-055) + supplier abbreviation), from an item list or a goods receipt. | 1 |
| CAT-09 | Bulk import and export of items and prices via CSV. | 2 |

## Related

Data model §4; D-004, D-014, D-019, D-055

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
