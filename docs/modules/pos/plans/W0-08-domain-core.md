# W0-08 Domain core: money, quantity, rounding, business date, golden tests

| | |
|---|---|
| **Issue** | [#9](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/9) |
| **Module** | pos (the `packages/domain` base for every checkout rule) |
| **Status** | Accepted (2026-10-22) |
| **Refs** | POS-15, PRD §7 (integrity); architecture §4.4, §12; posting rules §1.7; CLAUDE.md rules 1–2; D-036, D-056, D-079; skill `checkout-rules` |
| **Depends on** | W0-01 |
| **Size** | about 1 day |
| **Test-first** | Yes: golden cases are written before the code (architecture §12) |

## Goal

The small, exact building blocks every checkout and posting rule will use, so no rule ever has to think about floats, rounding direction, leftover paisa or "which day is it?" again. All pure functions, golden-tested, 100% covered.

## Design (D-079)

| Choice | Why |
|---|---|
| **Money is a branded integer `Money`** (minor units: paisa or fils), a plain JS number that must be a safe integer. **Quantity is a branded integer `Qty`** in thousandths (`1.5 m` = `1500`). | Plain numbers stay fast and JSON-friendly; Zod and the POS's SQLite handle them natively. The brand makes "added a quantity to an amount" a compile error. Safe integers go up to 90 trillion rupees. |
| **Products use `bigint` internally** (`qty × price ÷ 1000`), then come back to `Money` with a range check | `qty_milli × price` can pass 2^53 for large lines; doing it exactly in `bigint` means no silent precision loss. |
| **One rounding rule everywhere: half away from zero** (2.5 → 3, −2.5 → −3) | Returns and refunds mirror sales exactly: a refund of what was sold rounds the same way, negative. |
| **Allocation by largest remainder** (`allocate(total, weights)`): the parts always **sum exactly** to the total. Ties go to the larger weight, then to the earlier line. | Posting rules §1.7: a bill discount spread over lines, or a refund of a discounted bill, must add up to the paisa. The tie-break is deterministic, so the POS and the API always get the same split. |
| **Cash rounding** (`roundCash(amount, increment)`), with the tenant's increment (Delux: 100 = Rs 1), nearest, half away from zero. Returns `{ rounded, adjustment }`. | POS-15: the adjustment is posted to the rounding account. |
| **Exact decimal parsing** (`parseMoney("1,250.50", 2)`, `parseQty("1.5")`): from text to integers with no floats; too many decimals is an error, not a silent round | What staff type into the POS becomes exact integers. `parseFloat` and `toFixed` are already banned in `packages/domain` by lint. |
| **Business date** (`businessDate(instantMs, timeZone, cutoffHour)`): the tenant's local date, minus one day if the local hour is before the cutoff | Architecture §4.4 and D-056: a sale at 20:30 or 01:00 belongs to the same business day; 04:00 starts the next one. Uses `Intl` with the tenant's timezone; **the time is always passed in**, never read from the clock. |
| **Errors are `DomainError` with a stable `code`** (`not_integer`, `out_of_range`, `too_many_decimals`, `bad_weights`, …) | The POS shows a translated message for each code (i18n keys, rule 10); the API maps them to exceptions. |
| **Golden test harness:** one JSON file per rule in `packages/domain/golden/`, `{ cases: [{ name, input, expected } or { name, input, error }] }`, run by one small helper | The cases double as readable documentation and can be checked by the owner or the accountant. The same files will test the API's re-validation of synced sales. |
| **Property tests with `fast-check`** for the invariants (allocation always sums; each part is within 1 of its exact share; rounding is symmetric) | Golden cases cover the examples we think of; property tests try thousands we don't. |

## Scope

1. `packages/domain/src/`:
   - `money.ts` (`Money`, `money()`, `add`, `sub`, `negate`, `sum`, `mulQty` (qty × unit price), `mulBp` (amount × basis points), `parseMoney`)
   - `quantity.ts` (`Qty`, `qty()`, `parseQty`)
   - `rounding.ts` (`divRound` half away from zero, `roundCash`)
   - `allocate.ts`
   - `business-date.ts`
   - `errors.ts`, `index.ts`
2. `packages/domain/golden/*.json` and `src/testing/golden.ts` (the runner).
3. `fast-check` as a dev dependency of `packages/domain`.
4. The module README notes the API (one line per function).

**Out of scope:**
- Prices, tiers, floors, discounts, credit and returns rules (Wave 1, built on these)
- Formatting money for display (`packages/ui`, with the tenant locale)
- Tax (MVP has no tax)

## Order

1. **Golden cases first**, committed failing:
   - normal cases and boundaries (0, exact halves, negative, the largest safe amount)
   - allocation with ties, zero weights and a single line
   - business date at 03:59, 04:00 and 20:30, across midnight and month and year ends
2. The code, until the golden and property tests pass with **100% branch coverage** (the CI threshold from W0-01).
3. Lint stays clean: no floats, clock, randomness or I/O in `packages/domain`.

## Tests that prove it

- [ ] Golden cases pass for every function (about 80 cases).
- [ ] Property tests: allocations always sum to the total and never differ from the exact share by 1 paisa or more; `round(−x) = −round(x)`; parse ∘ format round-trips for valid input.
- [ ] Coverage of `packages/domain` is 100% lines, branches, functions and statements (enforced).
- [ ] Unsafe or non-integer input raises `DomainError` with the right code, never a wrong number.
- [ ] `pnpm check` green; the lint boundaries still hold.

## Risks

| Risk | Mitigation |
|---|---|
| A rule later needs a different rounding mode | Add a named mode then; the default stays half away from zero, documented in golden cases. |
| The ICU timezone data differs between Chrome and Node | Karachi and the UAE have no daylight saving; golden cases pin the expected dates, and both run the same tests. |
| `number` vs `bigint` boundary mistakes at the database | The DB driver returns `bigint` as text; conversion goes through `money()`, which rejects unsafe values. |

## Owner actions

None.
