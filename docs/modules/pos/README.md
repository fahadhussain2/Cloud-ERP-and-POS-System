# POS counter (`POS`)

| | |
|---|---|
| **Status** | In progress: W0-08 (domain core) |
| **Requirements** | 17 (POS-01…POS-17) |
| **Feature spec needed** | Yes: checkout screen and keyboard map; local DB and storage guardrails |

## Scope

The offline PWA on counter PCs: search, bill, tiers and overrides, customers, payment pad and tender, credit control, hold, printing and bill code, void, return/exchange, numbering, status, rounding, print profiles.

## Requirements

Full wording is in [the PRD](../../01-PRD.md). Wave 1 = critical path for go-live, Wave 2 = rest of the MVP.

| ID | Summary | Wave |
|---|---|---|
| POS-01 | Installable PWA on Chromium (Chrome/Edge). | 1 |
| POS-02 | Omni-search: one input that matches code, barcode scan, OEM/alternate numbers (normalized), name words in any order, and vehicle tags. | 1 |
| POS-03 | Fully keyboard-driven: function-key map, no mouse needed, visible shortcut hints. | 1 |
| POS-04 | Bill lines: quantity, unit price (from tier). | 1 |
| POS-05 | Customer selection: walk-in by default, fast search by name, phone or code. | 1 |
| POS-06 | Tender: cash (optional cash received, Enter = exact amount → change), bank/Raast, JazzCash, Easypaisa, card. | 1 |
| POS-07 | Credit control: limit check (synced balance + local unsynced) and offline daily cap per customer. | 1 |
| POS-08 | Hold / park bills and resume them on the same device. | 1 |
| POS-09 | Finalize → print the bill silently to the device's default printer (local or shared network printer) using its print profile (POS-16). | 1 |
| POS-10 | Reprint (marked REPRINT, logged). | 1 |
| POS-11 | Void with permission, PIN and reason within the void window; optional linked reissue. | 1 |
| POS-12 | Return / exchange screen per W6, including legacy bill lookup (90 days), reason and condition, no-receipt flow with PIN, return window and non-returnable… | 1 |
| POS-13 | Per-device document numbering, gapless and never reused (e.g. | 1 |
| POS-14 | Status bar: online/offline, last sync, unsynced count, warnings when offline longer than a threshold. | 1 |
| POS-15 | Cash rounding per tenant rule (e.g. | 1 |
| POS-16 | Print profiles: a tenant default, overridable per device. | 1 |
| POS-17 | Payment pad under the bill total. | 1 |

## Related

PRD W1–W7, W15; architecture §4 (offline design), §8 (printing); D-001–D-013, D-047–D-053; prototype: Tijara POS

## Work in this module

- `spec.md`: only if needed (see above), written before the first plan that depends on it.
- `plans/<wave>-<nn>-<slug>.md`: one accepted plan per task, before any code ([delivery process](../../07-DELIVERY-PROCESS.md) §3).
- `intent.md`: only for changes after the MVP.
