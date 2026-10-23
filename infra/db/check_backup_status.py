#!/usr/bin/env python3
"""Checks the backup status JSON written by `erp-db status` (W0-05, D-076, D-077).

    check_backup_status.py <status.json> [--max-wal-minutes 15] [--max-backup-hours 26] [--now <epoch>]

Exits 1 if backups are stale or failing. Run nightly by CI; W0-06 adds the same check as a Grafana alert.
"""
import argparse
import json
import sys
import time


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("status")
    p.add_argument("--max-wal-minutes", type=int, default=15)
    p.add_argument("--max-backup-hours", type=int, default=26)
    p.add_argument("--now", type=int, default=int(time.time()))
    a = p.parse_args()
    with open(a.status) as f:
        s = json.load(f)

    def age(key: str) -> int:
        return a.now - int(s[key])

    checks = [
        (age("generated_at") <= 1800, f"status file is fresh ({age('generated_at') // 60} min old, limit 30)"),
        (
            age("last_archived_at") <= a.max_wal_minutes * 60,
            f"last WAL archived {age('last_archived_at') // 60} min ago (limit {a.max_wal_minutes})",
        ),
        (
            s["last_failed_at"] <= s["last_archived_at"],
            f"no archive failure since the last success (failures in total: {s['failed_count']})",
        ),
        (
            age("last_backup_at") <= a.max_backup_hours * 3600,
            f"last backup ({s['last_backup_type'] or 'none'}) {age('last_backup_at') // 3600} h ago"
            f" (limit {a.max_backup_hours})",
        ),
        (s["stanza_status"] == "ok", f"backup repository status: {s['stanza_status']}"),
    ]
    for ok, message in checks:
        print(("ok    " if ok else "FAIL  ") + message)
    failed = sum(1 for ok, _ in checks if not ok)
    if failed:
        print(f"Backups need attention: {failed} check(s) failed.")
        return 1
    print("Backups are healthy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
