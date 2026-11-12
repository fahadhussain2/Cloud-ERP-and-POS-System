# Runbook: a sequence gap

**Seen on** (W1-07, sync spec §7, architecture §5.2): the back office's **Counters** list shows *N gaps* under *Missing bills* for a counter, and a `seq_gap` exception is open. A Grafana warning on new gaps is a devops follow-up (architecture §11.6).

The server has bill numbers from a counter above some it never received, e.g. `C03-S000411` and `C03-S000413` but no `S000412`. Every push answer tells the counter what is missing, and **the counter sends those bills again by itself** from its 30-day copy. Most gaps close within a push or two.

## Check

1. Is the counter online? On the Counters list: *Last seen* recent, *Waiting* empty. If it is offline, the gap closes when it comes back.
2. The open gaps and what the server holds (read only):
   ```bash
   ssh admin@204.168.217.64 "sudo docker exec -u postgres erp-prod-db psql -X -d erp -c \"SELECT v.code, g.family, g.from_seq, g.to_seq, g.opened_at FROM erp.sequence_gaps g JOIN erp.devices v ON v.id = g.device_id WHERE g.resolved_at IS NULL ORDER BY g.opened_at\""
   ```
3. On that counter's health page (`Alt+S`): anything under *Needs attention*? A refused bill isn't a gap (it counts as arrived), but its neighbours may be.

## Fix

| Cause | Action |
|---|---|
| The counter is offline or was off | Nothing: its next push sends the missing bills. |
| A server restore lost recent bills | Nothing: each counter's start-up push sees the lower `through` and re-sends its last 30 days (SYN-05). Open every counter once after a restore. |
| The missing bills are older than 30 days | They are no longer on the counter. Note it on the day's reconciliation; the gap stays as a record. |
| The counter's database was lost or rebuilt | Its unsynced bills are gone: compare its printed bills with the server and enter the difference as a correction (rule 3). Then find out why rule 9 failed. |
| A gap stays open while the counter is online and holds the bills | A bug: send diagnostics from the counter and call support. |

The gap resolves by itself (`resolved_at`) once every number in it has arrived, and the Counters list shows *No gaps*.
