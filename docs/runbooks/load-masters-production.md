# Runbook: load the legacy masters onto production

**When:** before the pilot (W1-14 owner answer 3), and again with each newer dump until go-live (D-104).

**What it loads** (`pnpm legacy:import`, W0-13): units, categories, brands, origins, vehicle makes, customers and suppliers, items with their identifiers, vehicle tags and tier prices, and the legacy expense accounts. **No stock and no balances:** those are the opening (`legacy:opening`, W1-14), loaded later from a late-November dump. **No sale bills** (D-100).

**Who runs it:** the owner, from their own terminal, on this PC. The dump and the staging database never leave the PC (D-084). The database password goes from the server straight into the terminal's environment; it is never typed into a command, written to a file or shown to Claude.

**Status: not usable yet (2026-11-12).** The importer sends one query per row, and the masters are about 150,000 rows (20,163 items, about 29,000 identifiers, 19,000 vehicle tags, 60,489 prices). Locally that takes about 2 minutes. Over the tunnel each query waits one round trip to Helsinki, measured at about 0.17 s from this PC, so the load would take **about 7 hours**, and the dry run would hold one transaction open on production for as long. The importer's writes have to be batched first (many rows per query). That is its own small task, with a plan. Once it's done, this runbook gets the new timing and its first run is the dry run in step 4.

## How it reaches production

- The database has **no public port** (D-076). It listens only on its Docker networks on the server.
- The server's SSH allows **local forwarding** for exactly this (`infra/server/files/ssh/10-erp-hardening.conf`). A tunnel connects `127.0.0.1:55432` on this PC to the database container's address on the server.
- The importer connects as **`erp_app`**, the role the apps use. It owns nothing and can't bypass RLS, so the import runs under the shop's isolation like the app does (D-085). It never uses the superuser or `erp_owner`.
- The importer reads the password from **`PGPASSWORD`** when its URL has none (node-postgres).

## Steps

Run everything in Git Bash, from the repo root.

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

Find the database container's address on its own network (the line ending `_default`):

```bash
ssh admin@204.168.217.64 "sudo docker inspect -f '{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}} {{\$v.IPAddress}}{{println}}{{end}}' erp-prod-db"
```

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
- the run fails. *Connection refused* means the tunnel is closed; *password authentication failed* means `PGPASSWORD` wasn't read.

### 5. The load

```bash
pnpm legacy:import --label nov2026
```

- The same counts as the dry run, now kept. Each group is its own transaction. (Timing: see Status.)
- If a run stops halfway, run it again: it continues where it stopped, matching by legacy key.
- **Optional check:** run it a second time. It should print *unchanged* everywhere.

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

## If something is wrong

- **A wrong value:** fix the mapping or the legacy data, then run the import again. It updates by legacy key; nothing has to be deleted first.
- **Something worse:** production has no documents yet, so a point-in-time restore to the time noted in step 1 loses nothing else. This is the production restore in infra README → Backups, done with Claude.
