# Runbook: a bill didn't post

**Seen on** (W1-08, accounting spec §3): the API logs `posting.failed` (an error, so it alerts: architecture §11.6), and the bill has an open `posting_failed` exception. The sale itself is fine: it was accepted, it is on the server and the counter is done with it (SYN-03). What's missing is its place in the books: no journal entry, no stock movement, no customer ledger entry.

The worker tries again every minute, so **once the cause is fixed the bill posts by itself**, in arrival order. Never re-enter the sale by hand.

## Check

1. The failed postings and their reason (read only):
   ```bash
   ssh admin@204.168.217.64 "sudo docker exec -u postgres erp-prod-db psql -X -d erp -c \"SELECT d.number, e.details, e.created_at FROM erp.exceptions e JOIN erp.sales_documents d ON d.id = e.document_id WHERE e.kind = 'posting_failed' AND NOT e.details ? 'postedAt' ORDER BY e.created_at\""
   ```
2. The log line, by bill:
   ```
   {env="prod", service="api"} | json | msg="posting.failed"
   ```
3. Whether the worker is still trying: `{env="prod", service="worker"} | json | msg="posting.pending"` shows the shop's `posted` and `failed` counts each minute that has work.

## Fix

| `details.code` | What it means | Action |
|---|---|---|
| `method_unmapped` | The bill was paid by a method with no bank account (e.g. Raast before it was mapped) | Map it in `infra/db/tenants/<shop>.json` and re-run `sudo erp-tenant setup prod <shop>`; the setup prints the change under *updated*. The next minute the worker posts the bill. |
| `role_unmapped` | The chart lacks an account the bill needs (e.g. 1190 *Posting suspense* on a shop set up before W1-08) | Re-run `sudo erp-tenant setup prod <shop>`: it creates the missing template accounts. |
| `on_account_without_customer` | A sale on account with no customer: a counter bug | Call support. The accountant may post it by journal voucher (W1-19); the exception stays for review. |
| `internal_error` | A bug or a database error (`details.message`) | Call support with the bill number. After the fix is deployed the worker posts it. |

## After

- The exception gets `postedAt` once the bill posts; review and close it (RPT-10, W1-20).
- If many bills were held, check the books: `sudo erp-tenant posting-check prod <shop>` should say *the ledgers match their documents*.
