# Release for the pilot: Wave 1 to production

| | |
|---|---|
| **Module** | devops (the release), with migration and pos for what follows it |
| **Status** | Draft (2026-11-12), for the owner to accept |
| **Refs** | D-063 (releases after shop hours), D-065 (the POS origin never changes), D-075 (one image per tree, health check, roll back), D-080 (`main` moves only by releases; hourly deferred runs), D-090 (pilot from 1 Dec), D-101 (the pilot wipe); [GO-LIVE-CHECKLIST](../../../GO-LIVE-CHECKLIST.md); `infra/README.md` → Deploys |
| **Depends on** | Every Wave 1 build task verified on staging (W1-02 to W1-23, done 2026-11-12) |
| **Size** | the release itself is one evening, about 1 hour of watching and checks; the follow-ups are listed with who does them |

## Goal

**Production runs what staging has tested,** with time left before the pilot on Tue 1 Dec to fix anything the release shows. Production was last released on 24 Oct (#41). It is **342 commits behind staging**, and its database has migrations up to `0006`.

## What goes out

- **Code:** all of Wave 1:
  - the counter: catalog, bill building, finalize and print, hold, void and reissue, return and exchange;
  - push and pull sync, and the posting engine;
  - the cash desk 1 and 2;
  - the back office: staff, catalog, customers, purchasing, labels, stock operations, accounting, reports and support;
  - W1-23's voids and returns by payment.
- **Database:** 16 migrations, `0007_temporary_pins` to `0022_void_cash`, in one deploy.
- **Server tools:** none in this release. The server is shared with staging, so `erp-tenant`, `erp-db` and the edge Caddy are already the versions staging uses (seed-catalog, posting-check and the SSE flush all ran there). Step 2 below confirms it.

## Why it is safe to roll back

- **Migrations only add, never break the 24 Oct code.** Checked in 0007–0022:
  - Every `DROP CONSTRAINT` is a check constraint dropped and re-created with more allowed values: `accounts`, `exceptions`, `postings`, `sync_inbox`, `device_series`, `sequence_gaps`, `overrides`, `locations`, `document_counters`, `cash_movements`.
  - The one `DROP COLUMN` (`sales_lines.unit_cost`, 0009) is on a table that 0008 creates in this same release.
  - So a rollback to the 24 Oct code runs on the new schema (D-075).
- **The release reuses staging's images.** `main` differs from `staging` only by three old merge commits with no changes, so the merge gives staging's exact tree, and the deploy loads the images staging built and tested (D-075). Nothing is rebuilt.
- **A failed migration stops the deploy** before the new version starts; the old version keeps running. A failed health check rolls back by itself.

## The steps

### 1. Before (the day of the release)

| Check | Who | Expected |
|---|---|---|
| **Freeze `staging`:** nothing merged into it from step 1 until the release is out | owner | the release is the commit staging last deployed and you tested |
| CI on the `staging` tip | Claude (`gh`) | green, and the staging deploy of that commit succeeded |
| **Backups:** the latest *Backup check* run | Claude (`gh`) | green today; WAL reaches B2 within 5 minutes, so the moment before the release can be restored |
| **What production runs now:** `cat /srv/erp/prod/releases.log`, the applied migrations, and counts only (tenants, items, parties, devices, users; never names) | Claude over SSH (needs your OK: production reads are blocked today) or owner | the 24 Oct release; migrations to `0006`; no counter has unsynced documents |

### 2. The release (an evening after 20:00 Karachi)

1. **The owner opens and merges a PR `staging` → `main`,** titled *Release: Wave 1 for the pilot*. Merged after 20:00, it deploys right away. Merged earlier, it waits for the next hourly run (:17 past each hour, 20:17 to 03:17 Karachi, D-080).
2. **Claude watches the *Deploy* run:**
   - the images are reused (`has` true);
   - the 16 migrations apply;
   - `/api/health` returns the new version, and the public HTTPS check passes.
3. **On the server** (Claude, with your OK):
   - `releases.log` shows the new tag;
   - `erp_meta.migrations` ends at `0022_void_cash`;
   - `sudo erp-tenant` lists `posting-check`, `wipe-pilot` and `go-live`;
   - the Caddyfile on the server matches `infra/edge/caddy/Caddyfile`.

### 3. The same evening, after the deploy

| Step | Who | Expected |
|---|---|---|
| `sudo erp-tenant setup prod delux` (go-live checklist) | Claude over SSH, output pasted here | it creates what's missing: `1190` *Posting suspense*, the default tax code, Raast and bank transfer mapped to HBL; no unexpected drift |
| `sudo erp-tenant posting-check prod delux` | Claude | 0 differences |
| The back office at `app.zorbixtechnologies.com`: sign in, every menu (Staff, Counters, Catalog, Customers, Purchasing, Stock, Accounting, Reports) opens; Exceptions and Day reconciliation load | owner | no error pages. **Nothing is posted or sold on production** (no test documents) |
| The POS at `pos.zorbixtechnologies.com` (never a new origin, D-065) loads the new version | owner | the setup screen. If a counter was set up on production before, it updates on its next load; its local database steps up by itself |

**If something is wrong:**
- **The deploy failed:** nothing to do on the server. The fix goes through `staging` as usual, then the release is made again.
- **It deployed but misbehaves:** revert the release merge on `main`. That deploys the 24 Oct code on the migrated database, which is safe as explained above. Then fix through `staging`.

### 4. The next UTC day

- **The November restore drill** (#95), the first on the new schema: `sudo erp-db restore-drill`, run detached, at most one drill per UTC day (B2's daily caps). Expected: `pg_amcheck: clean`.

### 5. Then, before the pilot on 1 Dec (from the go-live checklist)

| What | Who | When |
|---|---|---|
| The real masters on production (items, prices, customers, suppliers) from a dump, over an SSH tunnel as the app role (W1-14 owner answer 3) | owner, with Claude | after the release, before 1 Dec |
| Bill header lines (address, phone) | owner gives them | before the print test |
| W1-01 print test at the shop | owner | after the release, on a production counter or a staging one |
| Label template (DCAC) and stock settings on production (W1-17, W1-18) | owner | after the masters |
| Staff, roles and PINs on production; the storekeeper as Purchaser; the accountant, if any | owner | before 1 Dec |
| The pilot counters and the cash desk enrolled on production (`infra/counter-setup.md`) | owner, with Claude | the last days of November |
| The pilot opening from a late-November dump, then `posting-check prod delux` (W1-14 owner answers 2, 3) | owner, with Claude | by ~28 Nov |

## When

**Proposed:** Fri 13 Nov, after 20:00 Karachi. That leaves 2½ weeks before the pilot for the masters, the counters and any fix. Any evening this week or next works; the later it is, the less room there is for a fix release before 1 Dec.

## Questions for you

1. **The date:** Fri 13 Nov after 20:00, or another evening?
2. **Production access for Claude:** read-only checks before and after (step 1, step 2.3), plus `erp-tenant setup` and `posting-check` (step 3), over SSH with the admin key. Today the permission check blocks production reads. Do you allow these commands for the release evening, or would you rather run them and paste the output?
3. **The freeze:** no merges into `staging` from the release day until it is out. Does that suit you?

## Risks

| Risk | Mitigation |
|---|---|
| 16 migrations in one deploy, never run in one go on production data | CI applies all of them to a fresh database on every run, and staging applied them in order on its own data. Step 1 shows how much data production holds. A failure stops before the new version starts |
| An unknown state on production (a test counter, or data from earlier tries) | Step 1's read-only check, before the merge |
| The release lands in shop hours | The deploy workflow defers production deploys between 10:00 and 20:00 Karachi |
| A rollback after `setup` has run | `setup` only creates rows the 24 Oct code ignores (accounts, mappings); rolling back stays safe |
