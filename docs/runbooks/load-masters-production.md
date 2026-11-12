# Runbook: load the legacy masters onto production

**When:** before the pilot (W1-14 owner answer 3), and again with each newer dump until go-live (D-104).

**What it loads** (`pnpm legacy:import`, W0-13): units, categories, brands, origins, vehicle makes, customers and suppliers, items with their identifiers, vehicle tags and tier prices, and the legacy expense accounts. **No stock and no balances:** those are the opening (`legacy:opening`, W1-14), loaded later from a late-November dump. **No sale bills** (D-100).

**Who runs it:** the owner, from their own terminal, on this PC. The dump and the staging database never leave the PC (D-084). The database password goes from the server straight into the terminal's environment; it is never typed into a command, written to a file or shown to Claude.

**Status: in use.** First run on production 2026-11-13 (`nov2026`): the dry run took **1 min 24 s and 141 queries**, the load succeeded, posting-check clean (results in the W1-24 plan).

**Timing (W1-24):** The importer now writes in batches of up to 2,000 rows per query. The `nov2026` masters (about 150,000 rows) take **153 queries** on an empty catalog. Over the tunnel each query waits one round trip to Helsinki, measured at about 0.17 s from this PC: about 26 s of waiting, plus sending the data itself (some tens of MB through SSH), so **a few minutes** for the dry run and the same for the load. The importer prints its number of queries at the end of each run. Before W1-24 it was one query per row, about 7 hours.

## How it reaches production

- The database has **no public port** (D-076). It listens only on its Docker networks on the server.
- The server's SSH allows **local forwarding** for exactly this (`infra/server/files/ssh/10-erp-hardening.conf`). A tunnel connects `127.0.0.1:55432` on this PC to the database container's address on the server.
- The importer connects as **`erp_app`**, the role the apps use. It owns nothing and can't bypass RLS, so the import runs under the shop's isolation like the app does (D-085). It never uses the superuser or `erp_owner`.
- The importer reads the password from **`PGPASSWORD`** when its URL has none (node-postgres).

## Steps

Run everything in **Git Bash**, from the repo root (`cd "/d/Zorbix Products/Cloud-ERP-and-POS-System"`). PowerShell breaks steps 3 to 5: it has no `export`, `$(…)` or `time`. Only the tunnel (step 2) works in either shell.

### 1. Before

- **Backups:** the latest *Backup check* run on GitHub is green.
- **Note the time:**
  ```bash
  date -u
  ```
  With it, production can be restored to just before the load (point-in-time recovery, infra README → Backups).
- **Node 24** first on the PATH (nvm defaults to 22), and the local database up:
  ```bash
  export PATH="/c/Program Files/nodejs:$PATH"
  ```
  ```bash
  pnpm db:up
  ```
- **The dump staged locally:** `nov2026` (the 2026 dump of 5 Nov) is already staged from rehearsal 2. For a newer dump, stage it first under its own label:
  ```bash
  pnpm legacy:stage --label <label> --dump sql_dump/<folder>
  ```
- **The mapping's decisions** (`tools/legacy-import/mapping/delux.json`), optional now, possible on any later run:
  - `partyTiers`: which customers are mechanics (Mechanic prices);
  - `partyCredit`: credit limits. Without them, migrated credit customers start with no limit (D-085).

### 2. The tunnel (a second terminal tab)

Find the database container's address on its own network:

```bash
ssh admin@204.168.217.64 "sudo docker inspect -f '{{json .NetworkSettings.Networks}}' erp-prod-db"
```

It prints one line of JSON: take the `"IPAddress"` inside the network whose name ends in `_default`. (The command has no `$`, so it works in PowerShell too.)

Then open the tunnel with that address, and leave it running:

```bash
ssh -N -L 127.0.0.1:55432:<address>:5432 admin@204.168.217.64
```

It prints nothing while it's open. Ctrl+C closes it.

### 3. The password (the first terminal tab)

Read the password into this terminal's environment. It isn't shown on screen:

```bash
export PGPASSWORD="$(ssh admin@204.168.217.64 sudo cat /srv/erp/prod/db-secrets/erp_app-password)"
```

Then set the target. This URL has no password in it:

```bash
export LEGACY_TARGET_URL=postgres://erp_app@127.0.0.1:55432/erp
```

### 4. The dry run

```bash
pnpm legacy:import --label nov2026 --dry-run
```

- It does every write inside one transaction and rolls it back, so **nothing is kept**.
- It prints the counts per group and writes the reports to `tools/legacy-import/out/nov2026/reports/index.html`.

Expected on an empty production catalog, from the `nov2026` rehearsal, with everything under *created*:

| Group | Rows |
|---|--:|
| units | 5 |
| categories | 268 |
| brands | 303 |
| origins | 22 |
| vehicle makes | 21 |
| parties | 377 (134 customer and 287 supplier accounts) |
| items | 20,163 |
| identifiers | about 29,000 |
| vehicle tags | about 19,000 |
| prices | 60,489 |
| accounts | 44 |
| expense categories | 35 |

**Stop and ask** if:
- a count is far off;
- anything shows under *retired*;
- the run fails:
  - *ECONNREFUSED 127.0.0.1:55432*: the tunnel is closed;
  - *ECONNREFUSED 127.0.0.1:54329*: the **local** database (the staged dump) is down: `pnpm db:up`, then run it again;
  - *password authentication failed*: `PGPASSWORD` wasn't read in this tab;
  - *No package.json found*: the tab isn't in the repo folder.

### 5. The load

```bash
pnpm legacy:import --label nov2026
```

- The same counts as the dry run, now kept. Each group is its own transaction. A few minutes (see Status).
- If a run stops halfway, run it again: it continues where it stopped, matching by legacy key.
- **Optional check:** run it a second time. It should print *unchanged* everywhere, in about 33 queries.

### 6. After

- **Close the tunnel** (Ctrl+C in the second tab) and forget the password:
  ```bash
  unset PGPASSWORD LEGACY_TARGET_URL
  ```
- **The ledgers still match:**
  ```bash
  ssh admin@204.168.217.64 sudo erp-tenant posting-check prod delux
  ```
- **In the production back office:** Catalog shows the items (search a few known codes), and Customers and Suppliers show their lists. Nothing is in stock yet; that comes with the opening.
- **Record it:** the date, the label and the counts (no names) go in the go-live checklist's line for the masters.

## Looking at the data (optional, while the tunnel is open)

A database client such as Beekeeper Studio can use the same tunnel:
- **Connection:** PostgreSQL, host `127.0.0.1`, port `55432`, user `erp_app`, database `erp`, no SSL and no SSH in the client (the tunnel does both).
- **The password:** `printf %s "$PGPASSWORD" | clip` in the Git Bash tab, paste it, then clear the clipboard with `: | clip`. Don't save it in the client.
- **Read-only mode on:** `erp_app` can write, and this is production.
- **The tables look empty** until the connection names the shop (forced RLS). Start each query tab with this line and run it together with the query:
  ```sql
  SELECT set_config('app.tenant_id', (SELECT tenant_id::text FROM erp.tenant_directory WHERE code = 'delux'), false);
  ```
- Disconnect the client before closing the tunnel.

## If something is wrong

- **A wrong value:** fix the mapping or the legacy data, then run the import again. It updates by legacy key; nothing has to be deleted first.
- **Something worse:** production has no documents yet, so a point-in-time restore to the time noted in step 1 loses nothing else. This is the production restore in infra README → Backups, done with Claude.
