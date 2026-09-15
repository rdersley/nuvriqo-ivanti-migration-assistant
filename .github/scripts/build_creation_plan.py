#!/usr/bin/env python3
import json
import re
from collections import defaultdict
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'migration-input'
OUT = ROOT / 'migration-output'
OUT.mkdir(exist_ok=True)

# Repeated validation-list IDs observed across the supplied Retail inMotion ROX exports.
# These mappings are source-derived and are used only to preserve the source semantics
# in the plan. They do not create or modify Jira objects.
KNOWN_LOOKUPS = {
    'c67a22b626694ff0bfdd430b7081f689': 'person',
    '4e3cb760bb3841509f11970959795026': 'person',
    '06529a80deb04e9fbace3d13f5c46606': 'person',
    'd7421e724d784aac996114d4097faa98': 'department-or-location',
    'aeb71b7162f0457a809e1a55cce4ca30': 'customer',
}


def local(tag: str) -> str:
    return tag.split('}')[-1]


def child_text(parent, name: str) -> str:
    for child in list(parent):
        if local(child.tag).lower() == name.lower():
            return (child.text or '').strip()
    return ''


def descendants(root, name: str):
    n = name.lower()
    return [e for e in root.iter() if local(e.tag).lower() == n]


def clean_html(value: str) -> str:
    value = re.sub(r'<br\s*/?>', ' ', value or '', flags=re.I)
    value = re.sub(r'<[^>]+>', '', value)
    value = value.replace('&nbsp;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', value).strip()


def lookup_semantic(lookup_id: str) -> str:
    return KNOWN_LOOKUPS.get((lookup_id or '').lower(), '')


def infer_type(display_type: str, values, lookup_id: str, name: str):
    d = (display_type or '').lower().strip()
    semantic = lookup_semantic(lookup_id)
    if d == 'category':
        return 'section'
    if d in {'list', 'dropdown', 'radio', 'combobox', 'select'}:
        return 'select'
    if d == 'combo':
        if semantic == 'person':
            return 'user'
        if semantic in {'department-or-location', 'customer'}:
            return 'lookup-select'
        return 'lookup-select' if lookup_id else ('select' if values else 'text')
    if d in {'checkbox', 'boolean', 'yesno', 'yes/no'}:
        return 'checkbox'
    if 'date' in d:
        return 'date'
    if 'number' in d or 'integer' in d or 'decimal' in d:
        return 'number'
    if 'text area' in d or 'textarea' in d or 'multiline' in d:
        return 'paragraph'
    if values:
        return 'select'
    return 'text'


def option_values(param):
    vals = []
    for item in descendants(param, 'ServiceRequestTemplateParameterValue'):
        v = child_text(item, 'ParameterValue')
        if v and v not in vals:
            vals.append(v)
    return vals


def is_always_hidden(expr: str) -> bool:
    return (expr or '').strip().lower() in {'$(false)', 'false'}


def parse_offering(path: Path):
    root = ET.parse(path).getroot()
    templates = descendants(root, 'ServiceRequestTemplate')
    if not templates:
        return None
    t = templates[0]
    service = {
        'sourceFile': path.name,
        'name': child_text(t, 'Name') or path.stem,
        'description': clean_html(child_text(t, 'Description')),
        'status': child_text(t, 'Status'),
        'fields': [],
        'sections': [],
        'ignoredAlwaysHiddenFields': [],
    }
    for p in descendants(t, 'ServiceRequestTemplateParameter'):
        display = child_text(p, 'DisplayName') or child_text(p, 'Name')
        if not display:
            continue
        options = option_values(p)
        required_expr = child_text(p, 'RequiredExpression')
        visibility_expr = child_text(p, 'VisibilityExpression')
        lookup_id = child_text(p, 'ValidationListRecId')
        display_type = child_text(p, 'DisplayType')
        jira_type = infer_type(display_type, options, lookup_id, display)
        entry = {
            'sourceId': child_text(p, 'RecId'),
            'name': display.strip(),
            'sourceName': child_text(p, 'Name'),
            'description': clean_html(child_text(p, 'Description')),
            'displayType': display_type,
            'jiraType': jira_type,
            'validationListRecId': lookup_id,
            'lookupSemantic': lookup_semantic(lookup_id),
            'required': 'true' in required_expr.lower(),
            'requiredExpression': required_expr,
            'visibilityExpression': visibility_expr,
            'conditional': bool(visibility_expr.strip()) and not is_always_hidden(visibility_expr),
            'alwaysHidden': is_always_hidden(visibility_expr),
            'options': options,
            'sequence': int(child_text(p, 'SequenceNumber') or 0),
        }
        if entry['alwaysHidden']:
            service['ignoredAlwaysHiddenFields'].append(entry)
        elif jira_type == 'section':
            service['sections'].append(entry)
        else:
            service['fields'].append(entry)
    service['fields'].sort(key=lambda x: (x['sequence'], x['name'].lower()))
    service['sections'].sort(key=lambda x: (x['sequence'], x['name'].lower()))
    return service


def main():
    services = []
    for path in sorted(INPUT.glob('*.rox')):
        try:
            s = parse_offering(path)
            if s:
                services.append(s)
        except Exception as exc:
            services.append({'sourceFile': path.name, 'name': path.stem, 'error': str(exc), 'fields': [], 'sections': [], 'ignoredAlwaysHiddenFields': []})

    shared = defaultdict(list)
    for service in services:
        for f in service.get('fields', []):
            shared[f['name'].strip().lower()].append((service['name'], f))

    conflicts = []
    reusable = []
    for key, entries in sorted(shared.items()):
        types = sorted(set(f['jiraType'] for _, f in entries))
        merged_options = []
        for _, f in entries:
            for opt in f['options']:
                if opt not in merged_options:
                    merged_options.append(opt)
        item = {
            'name': entries[0][1]['name'],
            'services': [s for s, _ in entries],
            'types': types,
            'recommendedType': types[0] if len(types) == 1 else None,
            'options': merged_options,
        }
        if len(types) > 1:
            conflicts.append(item)
        elif len(entries) > 1:
            reusable.append(item)

    lookup_backed = []
    for service in services:
        for f in service.get('fields', []):
            if f['jiraType'] == 'lookup-select':
                lookup_backed.append({
                    'service': service['name'],
                    'field': f['name'],
                    'validationListRecId': f['validationListRecId'],
                    'lookupSemantic': f['lookupSemantic'],
                })

    plan = {
        'mode': 'PLAN_ONLY_NO_JIRA_WRITES',
        'serviceCount': len(services),
        'fieldOccurrences': sum(len(s.get('fields', [])) for s in services),
        'sectionHeadings': sum(len(s.get('sections', [])) for s in services),
        'ignoredAlwaysHiddenFieldCount': sum(len(s.get('ignoredAlwaysHiddenFields', [])) for s in services),
        'uniqueFieldNames': len(shared),
        'sharedReusableFieldNames': len(reusable),
        'typeConflictCount': len(conflicts),
        'lookupBackedFieldCount': len(lookup_backed),
        'services': services,
        'sharedReusableFields': reusable,
        'typeConflicts': conflicts,
        'lookupBackedFields': lookup_backed,
        'proposedBuildOrder': [
            'read-only Jira inventory / target project validation',
            'resolve validation-list backed department/location/customer values before creating Jira fields',
            'map person lookups to Jira user-picker fields',
            'reuse compatible existing Jira fields',
            'create missing shared fields and options',
            'create/reuse one issue type per offering',
            'create request types in the target JSM project',
            'recreate category headings as form sections, not Jira fields',
            'create forms and conditional visibility rules',
            'create screens/workflows only where source data supports them',
            'validate created objects by read-back before continuing',
        ],
    }

    (OUT / 'jira-creation-plan.json').write_text(json.dumps(plan, indent=2), encoding='utf-8')
    lines = [
        '# Jira creation plan from Ivanti ROX offerings', '',
        '**PLAN ONLY — this file does not change Jira.**', '',
        f"- Services: {plan['serviceCount']}",
        f"- Jira field occurrences: {plan['fieldOccurrences']}",
        f"- Ivanti category headings to recreate as form sections: {plan['sectionHeadings']}",
        f"- Always-hidden source fields excluded from Jira creation: {plan['ignoredAlwaysHiddenFieldCount']}",
        f"- Unique field names: {plan['uniqueFieldNames']}",
        f"- Reusable shared field names: {plan['sharedReusableFieldNames']}",
        f"- Type conflicts: {plan['typeConflictCount']}",
        f"- Validation-list backed non-user lookups: {plan['lookupBackedFieldCount']}", '',
        '## Services', '',
        '| Service | Fields | Sections | Hidden excluded | Required | Conditional | Select options |',
        '|---|---:|---:|---:|---:|---:|---:|',
    ]
    for s in services:
        fields = s.get('fields', [])
        lines.append(f"| {s['name']} | {len(fields)} | {len(s.get('sections', []))} | {len(s.get('ignoredAlwaysHiddenFields', []))} | {sum(1 for f in fields if f['required'])} | {sum(1 for f in fields if f['conditional'])} | {sum(len(f['options']) for f in fields)} |")
    if conflicts:
        lines += ['', '## Field type conflicts', '']
        for c in conflicts:
            lines.append(f"- {c['name']}: {', '.join(c['types'])} across {', '.join(c['services'])}")
    if lookup_backed:
        lines += ['', '## Lookup-backed fields requiring source-value resolution', '']
        for u in lookup_backed:
            lines.append(f"- {u['service']} / {u['field']} — {u['lookupSemantic'] or 'unknown lookup'} — validation list {u['validationListRecId']}")
    (OUT / 'jira-creation-plan.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    print(json.dumps({k: v for k, v in plan.items() if k not in {'services','sharedReusableFields','typeConflicts','lookupBackedFields','proposedBuildOrder'}}, indent=2))
    for s in services:
        print(f"{s['name']}: fields={len(s.get('fields', []))} sections={len(s.get('sections', []))} hiddenExcluded={len(s.get('ignoredAlwaysHiddenFields', []))}")
    return 1 if any('error' in s for s in services) else 0


if __name__ == '__main__':
    raise SystemExit(main())
