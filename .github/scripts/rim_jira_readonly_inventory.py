#!/usr/bin/env python3
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "migration-output" / "jira-inventory"
OUT.mkdir(parents=True, exist_ok=True)

SITE = os.environ.get("RIM_FORGE_SITE", "").strip().replace("https://", "").rstrip("/")
EMAIL = os.environ.get("FORGE_EMAIL", "").strip()
TOKEN = os.environ.get("FORGE_API_TOKEN", "").strip()

if not (SITE and EMAIL and TOKEN):
    print("Missing RIM_FORGE_SITE/FORGE_EMAIL/FORGE_API_TOKEN", file=sys.stderr)
    raise SystemExit(2)

AUTH = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
BASE = f"https://{SITE}"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={
            "Authorization": f"Basic {AUTH}",
            "Accept": "application/json",
            "User-Agent": "nuvriqo-ivanti-migration-readonly-inventory/1.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return {"status": r.status, "data": json.loads(r.read().decode("utf-8"))}
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body[:2000]
        return {"status": e.code, "error": parsed}
    except Exception as e:
        return {"status": 0, "error": str(e)}


inventory = {
    "mode": "READ_ONLY_NO_JIRA_WRITES",
    "site": SITE,
    "auth": {},
    "projects": [],
    "serviceDesks": [],
    "fields": [],
    "issueTypes": [],
    "requestTypesByServiceDesk": {},
    "errors": [],
}

me = get("/rest/api/3/myself")
inventory["auth"] = {"status": me.get("status")}
if me.get("status") == 200:
    data = me["data"]
    inventory["auth"].update({
        "accountId": data.get("accountId"),
        "displayName": data.get("displayName"),
        "active": data.get("active"),
    })
else:
    inventory["errors"].append({"endpoint": "myself", **me})
    (OUT / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
    print(json.dumps(inventory["auth"], indent=2))
    raise SystemExit(1)

projects = get("/rest/api/3/project/search?maxResults=100&orderBy=name")
if projects.get("status") == 200:
    for p in projects["data"].get("values", []):
        inventory["projects"].append({
            "id": p.get("id"), "key": p.get("key"), "name": p.get("name"),
            "projectTypeKey": p.get("projectTypeKey"), "style": p.get("style"),
        })
else:
    inventory["errors"].append({"endpoint": "projects", **projects})

fields = get("/rest/api/3/field")
if fields.get("status") == 200:
    for f in fields["data"]:
        schema = f.get("schema") or {}
        inventory["fields"].append({
            "id": f.get("id"), "name": f.get("name"), "custom": f.get("custom"),
            "schemaType": schema.get("type"), "customType": schema.get("custom"),
        })
else:
    inventory["errors"].append({"endpoint": "fields", **fields})

issue_types = get("/rest/api/3/issuetype")
if issue_types.get("status") == 200:
    for t in issue_types["data"]:
        inventory["issueTypes"].append({
            "id": t.get("id"), "name": t.get("name"), "subtask": t.get("subtask"),
            "scope": t.get("scope"),
        })
else:
    inventory["errors"].append({"endpoint": "issuetype", **issue_types})

service_desks = get("/rest/servicedeskapi/servicedesk?limit=100")
if service_desks.get("status") == 200:
    for sd in service_desks["data"].get("values", []):
        item = {
            "id": sd.get("id"), "projectId": sd.get("projectId"),
            "projectName": sd.get("projectName"), "projectKey": sd.get("projectKey"),
        }
        inventory["serviceDesks"].append(item)
        sid = str(sd.get("id"))
        rts = get(f"/rest/servicedeskapi/servicedesk/{urllib.parse.quote(sid)}/requesttype?limit=100")
        if rts.get("status") == 200:
            inventory["requestTypesByServiceDesk"][sid] = [
                {
                    "id": rt.get("id"), "name": rt.get("name"),
                    "description": rt.get("description"), "issueTypeId": rt.get("issueTypeId"),
                    "portalId": rt.get("portalId"), "groupIds": rt.get("groupIds"),
                }
                for rt in rts["data"].get("values", [])
            ]
        else:
            inventory["errors"].append({"endpoint": f"requesttypes:{sid}", **rts})
else:
    inventory["errors"].append({"endpoint": "servicedesk", **service_desks})

summary = {
    "mode": inventory["mode"],
    "site": SITE,
    "authStatus": inventory["auth"].get("status"),
    "projectCount": len(inventory["projects"]),
    "serviceDeskCount": len(inventory["serviceDesks"]),
    "fieldCount": len(inventory["fields"]),
    "customFieldCount": sum(1 for f in inventory["fields"] if f.get("custom")),
    "issueTypeCount": len(inventory["issueTypes"]),
    "requestTypeCount": sum(len(v) for v in inventory["requestTypesByServiceDesk"].values()),
    "errorCount": len(inventory["errors"]),
}

(OUT / "inventory.json").write_text(json.dumps(inventory, indent=2), encoding="utf-8")
(OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

md = [
    "# Retail inMotion Jira read-only inventory", "",
    "**READ ONLY — no Jira configuration changes are performed.**", "",
    f"- Site: {SITE}",
    f"- Authentication: HTTP {summary['authStatus']}",
    f"- Projects visible: {summary['projectCount']}",
    f"- JSM service desks visible: {summary['serviceDeskCount']}",
    f"- Fields visible: {summary['fieldCount']} ({summary['customFieldCount']} custom)",
    f"- Issue types visible: {summary['issueTypeCount']}",
    f"- Request types visible: {summary['requestTypeCount']}",
    f"- Read errors: {summary['errorCount']}", "",
    "## JSM service desks", "",
    "| ID | Project key | Project name |",
    "|---|---|---|",
]
for sd in inventory["serviceDesks"]:
    md.append(f"| {sd.get('id','')} | {sd.get('projectKey','')} | {sd.get('projectName','')} |")
if inventory["errors"]:
    md += ["", "## Read errors", ""]
    for e in inventory["errors"]:
        md.append(f"- {e.get('endpoint')}: HTTP {e.get('status')}")
(OUT / "inventory.md").write_text("\n".join(md) + "\n", encoding="utf-8")

print(json.dumps(summary, indent=2))
raise SystemExit(0 if summary["authStatus"] == 200 else 1)
