#!/usr/bin/env python3
import json
import sys
from pathlib import Path
import xml.etree.ElementTree as ET
from html import unescape

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "migration-input"
OUT_DIR = ROOT / "migration-output"
OUT_DIR.mkdir(exist_ok=True)


def text_of(parent, tag):
    for child in list(parent):
        if child.tag.split('}')[-1].lower() == tag.lower():
            return (child.text or '').strip()
    return ''


def local(tag):
    return tag.split('}')[-1].lower()


def parse_inner_xml(value):
    if not value:
        return None
    candidates = [value, unescape(value)]
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            return ET.fromstring(candidate)
        except ET.ParseError:
            pass
    return None


def descendants(root, name):
    name = name.lower()
    return [e for e in root.iter() if local(e.tag) == name]


def parse_file(path: Path):
    result = {
        "file": path.name,
        "size": path.stat().st_size,
        "parseStatus": "ok",
        "serviceName": path.stem,
        "displayName": "",
        "description": "",
        "objectType": "",
        "workflowBlocks": 0,
        "workflowEdges": 0,
        "quickActions": 0,
        "blockTypes": {},
        "triggerConditions": 0,
        "warnings": [],
    }
    try:
        root = ET.parse(path).getroot()
    except Exception as exc:
        result["parseStatus"] = "failed"
        result["warnings"].append(f"Outer XML parse failed: {exc}")
        return result

    wf_defs = descendants(root, "WorkflowDefinition")
    wf_types = descendants(root, "WorkflowType")
    if wf_defs:
        wf = wf_defs[0]
        result["serviceName"] = text_of(wf, "Name") or result["serviceName"]
        details = text_of(wf, "Details")
        trigger_details = text_of(wf, "TriggerDetails")
        inner = parse_inner_xml(details)
        if inner is None:
            result["warnings"].append("Workflow Details XML could not be parsed")
        else:
            blocks = descendants(inner, "block")
            result["workflowBlocks"] = len(blocks)
            types = {}
            edges = 0
            for block in blocks:
                block_type = text_of(block, "type").strip().lower() or "unknown"
                types[block_type] = types.get(block_type, 0) + 1
                for ex in descendants(block, "exit"):
                    links = descendants(ex, "link")
                    edges += len(links)
            result["blockTypes"] = dict(sorted(types.items()))
            result["workflowEdges"] = edges
        trigger = parse_inner_xml(trigger_details)
        if trigger is not None:
            result["triggerConditions"] = len(descendants(trigger, "group"))
    else:
        result["warnings"].append("WorkflowDefinition not found")

    if wf_types:
        wt = wf_types[0]
        result["displayName"] = text_of(wt, "DisplayName")
        result["description"] = text_of(wt, "Description")
        result["objectType"] = text_of(wt, "ObjectType")

    result["quickActions"] = len(descendants(root, "QuickAction"))
    if result["workflowBlocks"] == 0:
        result["warnings"].append("No workflow blocks detected")
    return result


def main():
    files = sorted(INPUT.glob("*.rox"))
    if not files:
        print("No .rox files found in migration-input", file=sys.stderr)
        return 2

    records = [parse_file(path) for path in files]
    failed = [r for r in records if r["parseStatus"] != "ok"]
    plan = {
        "mode": "DRY_RUN_ONLY",
        "inputCount": len(records),
        "failedCount": len(failed),
        "totalBytes": sum(r["size"] for r in records),
        "totalWorkflowBlocks": sum(r["workflowBlocks"] for r in records),
        "totalWorkflowEdges": sum(r["workflowEdges"] for r in records),
        "totalQuickActions": sum(r["quickActions"] for r in records),
        "files": records,
    }

    (OUT_DIR / "migration-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")

    md = [
        "# Retail inMotion Ivanti migration dry-run",
        "",
        "**No Jira configuration is changed by this workflow.**",
        "",
        f"- ROX files: {plan['inputCount']}",
        f"- Parse failures: {plan['failedCount']}",
        f"- Workflow blocks detected: {plan['totalWorkflowBlocks']}",
        f"- Workflow edges detected: {plan['totalWorkflowEdges']}",
        f"- Quick actions detected: {plan['totalQuickActions']}",
        "",
        "| File | Service/workflow | Blocks | Edges | Quick actions | Warnings |",
        "|---|---|---:|---:|---:|---|",
    ]
    for r in records:
        warnings = "; ".join(r["warnings"]) if r["warnings"] else ""
        md.append(f"| {r['file']} | {r['serviceName']} | {r['workflowBlocks']} | {r['workflowEdges']} | {r['quickActions']} | {warnings} |")
    (OUT_DIR / "migration-plan.md").write_text("\n".join(md) + "\n", encoding="utf-8")

    print(json.dumps({k: v for k, v in plan.items() if k != "files"}, indent=2))
    for r in records:
        print(f"{r['file']}: {r['parseStatus']} blocks={r['workflowBlocks']} edges={r['workflowEdges']} quickActions={r['quickActions']} warnings={len(r['warnings'])}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
