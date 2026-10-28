# Runbook: a bill needs attention

**Seen on** (W1-07, sync spec §6.2, POS spec §14): the counter's status bar says *N bills need attention*; its health page (`Alt+S`) lists them; the back office's **Counters** list shows *N refused* on that counter. A Grafana alert on repeated refusals from one device is a devops follow-up (architecture §11.6).

The server refused the bill because it can't trust or store it. **The bill is safe on the counter** (rule 9): never clear that PC's browser data, and don't re-enter the sale by hand, or it will exist twice.

## Check

1. On the counter's health page: the bill number and the reason.
2. The server's answer and its reason, by bill number or document id:
   ```
   {env="prod", service="api"} | json | msg="sync.push.document" | status="rejected"
   ```
3. What the server holds of that id (read only):
   ```bash
   ssh admin@204.168.217.64 "sudo docker exec -u postgres erp-prod-db psql -X -d erp -c \"SELECT document_id, status, result, attempts, received_at FROM erp.sync_inbox WHERE result->>'id' = '<document id>'\""
   ```

## Fix

| Reason on the counter | What it means | Action |
|---|---|---|
| Not signed by this counter (`unsigned`) | The counter couldn't sign it at finalize, nor before sending | *Try again* (a manager): push signs it first. If it comes back the same, the counter's key is missing: send diagnostics and call support before anything else. |
| The signature does not match (`bad_signature`) | The bill changed after it was signed, or another key signed it | **Don't try again.** Treat as tampering: a `bad_signature` exception is open on the server. Check who used the PC; call support. |
| The server could not read it (`bad_schema`) | A counter version the server doesn't know, or a bug | Update the server or the counter (the server accepts the previous counter version, architecture §4.2), then *Try again*. |
| It names an item, person or payment method the server does not know (`unknown_reference`) | Something was removed on the server, or a bug | Find which in the log line above; restore it, then *Try again*. |
| Another bill already has its number (`seq_conflict`) | Two bills with one number from this counter | Don't try again: call support. The counter's database must not be rebuilt (rule 9). |
| Another bill already has its id (`id_conflict`) | The same id with different contents | Don't try again: call support. |
| It belongs to another counter (`wrong_device`) | A document from another device | Call support. |

*Try again* needs a manager's PIN (`admin.devices`). The bill is pushed at once; afterwards the counter's status bar and the Counters list show nothing waiting.
