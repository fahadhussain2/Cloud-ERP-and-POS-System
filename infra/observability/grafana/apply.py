"""Applies the Grafana side of observability (W0-06, D-086): the ERP folder, the System dashboard, the alert rules
and the notification policy (critical to erp-critical, the rest to erp-alerts). Safe to run again.

    python infra/observability/grafana/apply.py

It asks for the stack URL and a service-account token (hidden; never stored). The contact points erp-critical and
erp-alerts must already exist (they hold the Slack webhooks, which stay out of git). Standard library only.
"""

import getpass
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "https://github.com/fahadhussain2/Cloud-ERP-and-POS-System/blob/main/"
FOLDER = {"uid": "erp", "title": "ERP"}
GROUP = "erp"


class Grafana:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body=None, ok_missing=False):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        # Keep everything editable in the Grafana UI too.
        req.add_header("X-Disable-Provenance", "true")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as err:
            if ok_missing and err.code == 404:
                return None
            sys.exit(f"apply: {method} {path} failed: {err.code} {err.read().decode()[:300]}")


def rule_body(rule: dict, uids: dict) -> dict:
    ds = uids[rule["datasource"]]
    query = {"refId": "A", "expr": rule["expr"], "instant": True, "range": False}
    if rule["datasource"] == "logs":
        query["queryType"] = "instant"
    return {
        "uid": rule["uid"],
        "title": rule["title"],
        "ruleGroup": GROUP,
        "folderUID": FOLDER["uid"],
        "condition": "C",
        "for": rule["for"],
        "noDataState": rule["noData"],
        "execErrState": "Error",
        "labels": {"severity": rule["severity"]},
        "annotations": {"summary": rule["summary"], "runbook_url": REPO + rule["runbook"]},
        "data": [
            {"refId": "A", "relativeTimeRange": {"from": 900, "to": 0}, "datasourceUid": ds, "model": query},
            {"refId": "B", "datasourceUid": "__expr__",
             "model": {"refId": "B", "type": "reduce", "expression": "A", "reducer": "last"}},
            {"refId": "C", "datasourceUid": "__expr__",
             "model": {"refId": "C", "type": "threshold", "expression": "B",
                       "conditions": [{"evaluator": {"type": rule["op"], "params": [rule["threshold"]]}}]}},
        ],
    }


def main() -> None:
    url = input("Grafana stack URL (https://<stack>.grafana.net): ").strip()
    if not url.startswith("https://"):
        sys.exit("apply: the URL starts with https://")
    token = getpass.getpass("Service account token (hidden): ").strip()
    g = Grafana(url, token)

    sources = g.call("GET", "/api/datasources")
    uids = {}
    for s in sources:
        if s["type"] == "prometheus" and s["name"].endswith("-prom"):
            uids["prom"] = s["uid"]
        if s["type"] == "loki" and s["name"].endswith("-logs"):
            uids["logs"] = s["uid"]
    if set(uids) != {"prom", "logs"}:
        sys.exit("apply: couldn't find the grafanacloud-…-prom and -logs data sources")

    names = {c["name"] for c in g.call("GET", "/api/v1/provisioning/contact-points")}
    missing = {"erp-critical", "erp-alerts"} - names
    if missing:
        sys.exit(f"apply: create the contact points first: {', '.join(sorted(missing))}")

    if g.call("GET", f"/api/folders/{FOLDER['uid']}", ok_missing=True) is None:
        g.call("POST", "/api/folders", FOLDER)
    print("folder ERP ready")

    dashboard = json.loads((HERE.parent / "dashboards" / "system.json").read_text(encoding="utf-8"))
    g.call("POST", "/api/dashboards/db", {"dashboard": dashboard, "folderUid": FOLDER["uid"], "overwrite": True})
    print("dashboard System ready")

    rules = json.loads((HERE / "alert-rules.json").read_text(encoding="utf-8"))["rules"]
    for rule in rules:
        body = rule_body(rule, uids)
        if g.call("GET", f"/api/v1/provisioning/alert-rules/{rule['uid']}", ok_missing=True) is None:
            g.call("POST", "/api/v1/provisioning/alert-rules", body)
        else:
            g.call("PUT", f"/api/v1/provisioning/alert-rules/{rule['uid']}", body)
        print(f"rule ready: {rule['title']} ({rule['severity']})")
    g.call("PUT", f"/api/v1/provisioning/folder/{FOLDER['uid']}/rule-groups/{GROUP}",
           {"title": GROUP, "interval": 60, "rules": [rule_body(r, uids) for r in rules]})

    # One message per incident and a "resolved" message; critical also goes by email (on erp-critical).
    g.call("PUT", "/api/v1/provisioning/policies", {
        "receiver": "erp-alerts",
        "group_by": ["alertname", "job", "service", "env"],
        "group_wait": "30s",
        "group_interval": "5m",
        "repeat_interval": "4h",
        "routes": [{"receiver": "erp-critical", "object_matchers": [["severity", "=", "critical"]],
                    "repeat_interval": "1h"}],
    })
    print("notification policy ready: critical -> erp-critical, everything else -> erp-alerts")


if __name__ == "__main__":
    main()
