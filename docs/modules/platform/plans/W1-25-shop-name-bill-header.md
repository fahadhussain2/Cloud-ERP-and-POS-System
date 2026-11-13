# W1-25 The shop's name and bill header, set by the owner

| | |
|---|---|
| **Issue** | [#155](https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/issues/155) |
| **Module** | platform (with pos for the printed bill, and `packages/print`) |
| **Status** | Built (2026-11-13), in review. Plan accepted by the owner (PR #156, answers 1–3: yes) |
| **Refs** | PLT-01 (receipt header), POS-09 (what the bill shows); POS spec §13; data model (`tenants`, `branches`, `print_profiles`); D-083 (setup from a spec, never overwrites), D-106 (the label template, the same owner-only pattern); go-live checklist: *Bill header*, *Bill print test* |
| **Depends on** | W1-06 (the printed bill), W1-17 (`admin.settings`, the owner-only settings pattern) |
| **Size** | about 1 day |
| **Test-first** | Yes: the header order (golden), the settings API with RLS, permission and audit (integration), the counter picking up a change (e2e) |

## The problem

The bill and the cash desk slip print **the shop's name**, then **header lines**, but nothing after setup can change either:
- **The name** is `tenants.name`, set once from `infra/db/tenants/delux.json`: *Delux Autos*. The shop is *Delux City Auto Corner*.
- **The header lines** are the branch's address, its phone and `branches.receipt_header.lines`, then the print profile's `headerLines` (POS spec §13). Delux's are all empty, so the bill shows only the name. The legacy dump has no address or phone either (W0-13 owner review).
- **The policy line** at the bottom is the print profile's `policyText`, else the default *Exchange or return within 30 days with this bill.*
- `erp-tenant setup` never overwrites a live shop (D-083), and there's no screen.

The pilot on 1 Dec prints real bills to customers, and the W1-01 print test should use the real header.

## Goal

**The owner sets the shop's name, address, phone, a few extra header lines and the policy line in the back office.** Every counter and the cash desk print them from their next pull, online within seconds and offline once they reconnect. No server access, no support, no release.

## Design

| Choice | Why |
|---|---|
| **One back-office screen, *Shop and bill*,** in the *Shop* menu next to Counters. **Owner only** (`admin.settings`, as the label template, D-106) | It's what customers see on every bill; the owner decides it |
| **Fields:**<br>• **Shop name** (required, up to 60 characters): `tenants.name`<br>• **Address** and **Phone** (optional, one line each): the branch's `address`, `phone`<br>• **Extra lines** (up to 3, optional): `branches.receipt_header.lines`, e.g. *Dealers in genuine parts*<br>• **Policy line** (optional): the default print profile's `template_options.policyText`; empty prints the default | Exactly what the bill already prints, so the counter's printing code doesn't change. **No new tables or columns** |
| **Each line up to 60 characters**, trimmed; empty lines dropped | Fits the A5 landscape bill on one line each. Question 2 |
| **A preview** of the top of the bill and its policy line, updated as the owner types | The owner sees the result before a counter prints it |
| **The order of the header lines moves to `packages/print`** (`billHeaderLines`, pure, golden-tested), used by the counter and the preview | One rule, so the preview can't differ from the bill |
| **One save, one transaction:** `PUT /api/settings/shop` updates the tenant, the branch and the default print profile. Every change goes to the audit log with before and after (`tenants`, `branches` and `print_profiles` already have it) | All or nothing; who changed the header and when is traceable |
| **The counters pick it up by the normal pull:** `tenants`, `branches` and the print profile are already pulled (sync spec §3), and an update gives them a new txid. All three already send the SSE nudge, so an online counter has it in seconds | No sync change |
| **Bills already printed don't change.** A reprint prints the header as it is now: the header isn't part of the bill's data (rule 3 holds) | A reprint is a copy for the customer, and the shop's current address is the useful one |
| **Setup stops reporting these fields as drift:** after creation the shop owns its name, address, phone, extra lines and policy line. `erp-tenant setup` still creates them for a new shop from its spec | Otherwise every owner edit shows as drift on each setup run. **A new decision, D-112, amending D-083** |
| **The Delux spec gets the real name,** *Delux City Auto Corner*, so git matches the shop. It changes nothing on production (setup never overwrites) | The spec is the reviewed record of the shop |

## Scope

- **In:**
  - `packages/print`: `billHeaderLines` (shop name, address, phone, extra lines, profile lines), golden-tested; the counter's `checkout.ts` uses it.
  - `packages/contracts`: the request and view (`ShopSettings`), with the limits.
  - `apps/api`: `GET` and `PUT /api/settings/shop` (`admin.settings`), inside `withTenant`, audited.
  - `apps/backoffice`: the *Shop and bill* screen with the preview, i18n keys (en), logical CSS.
  - `packages/db/src/setup/tenant.ts`: no drift for the owner's fields.
  - `infra/db/tenants/delux.json`: the real name.
  - Docs: platform spec, POS spec §13, D-112, `WAVE-1-TASKS.md` (the W1-25 row), go-live checklist (the *Bill header* line points here).
- **Out:**
  - **Changing the shop code** (`delux`, typed at sign-in) or the POS origin (D-065).
  - **The branch's own name** (not printed anywhere) and other branches: Delux has one. Several branches get their own header with multi-branch (Wave 2+).
  - **A logo:** the bill is text on a dot-matrix-friendly page; a later task if wanted.
  - **The legal name and tax number on the bill:** `tax_mode` is *none* for Delux.
  - **Thermal templates** (POS spec §13, owner answer 2).
  - **Typing Delux's real header:** the owner does it on production after the release.

## Tests written first

- **Golden (`packages/print`):** `billHeaderLines`: the order (address, phone, extra lines, then the profile's lines); empty and blank lines dropped; nothing but the name when all are empty.
- **Integration (`apps/api`):**
  - The owner saves, and `GET` returns it; the tenant, branch and print profile rows hold it; the audit log has before and after.
  - A manager (no `admin.settings`) gets 403; the other shop's rows are untouched (RLS).
  - Refused: an empty name, a line over 60 characters, more than 3 extra lines.
  - The change bumps the rows' txid, so the counter's next pull returns them.
- **Setup:** a shop whose owner changed the name and header shows no drift for them.
- **Unit (back office):** the screen loads, validates, saves, and the preview follows the fields.
- **e2e:** the owner changes the shop name and an extra line in the back office; the counter's next pull shows the new name in its status bar, and the printed bill's header has them.

## Verify

1. `pnpm check`, `pnpm test:integration`, `pnpm e2e`, output shown.
2. **On staging, by the owner:** in the `demo` shop, change the name and the header, then on a staging counter print a bill and see them; reprint an older bill. Then put them back.
3. **After the release, on production:** the owner types Delux's real name, address and phone. The W1-01 print test then prints the real header.

## Questions for you

1. **Size:** about 1 day. Accept?
2. **The limits:** up to 3 extra lines, each line up to 60 characters. Enough for what you want on the bill?
3. **The release:** this needs a production release after it's built, before the print test. An evening after 20:00, the same as the Wave 1 release. All right?

## Risks

| Risk | Mitigation |
|---|---|
| A long line wraps or is cut on the A5 bill | The 60-character limit; the staging print test (Verify 2) on the real printer |
| Someone changes the header by mistake | Owner only; every change in the audit log with before and after |
| An offline counter prints the old header for a while | Expected: it prints the new one from its next pull. The header is not a business rule, so nothing is refused or reconciled |
