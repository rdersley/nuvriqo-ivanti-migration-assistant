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


def infer_type(display_type: str, values):
    d = (display_type or '').lower()
    if d in {'list', 'dropdown', 'radio', 'combobox', 'select'}:
        return 'select'
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
    }
    for p in descendants(t, 'ServiceRequestTemplateParameter'):
        display = child_text(p, 'DisplayName') or child_text(p, 'Name')
        if not display:
            continue
        options = option_values(p)
        required_expr = child_text(p, 'RequiredExpression')
        visibility_expr = child_text(p, 'VisibilityExpression')
        field = {
            'sourceId': child_text(p, 'RecId'),
            'name': display.strip(),
            'sourceName': child_text(p, 'Name'),
            'description': clean_html(child_text(p, 'Description')),
            'displayType': child_text(p, 'DisplayType'),
            'jiraType': infer_type(child_text(p, 'DisplayType'), options),
            'required': 'true' in required_expr.lower(),
            'requiredExpression': required_expr,
            'visibilityExpression': visibility_expr,
            'conditional': bool(visibility_expr.strip()),
            'options': options,
            'sequence': int(child_text(p, 'SequenceNumber') or 0),
        }
        service['fields'].append(field)
    service['fields'].sort(key=lambda x: (x['sequence'], x['name'].lower()))
    return service


def main():
    services = []
    for path in sorted(INPUT.glob('*.rox')):
        try:
            s = parse_offering(path)
            if s:
                services.append(s)
        except Exception as exc:
            services.append({'sourceFile': path.name, 'name': path.stem, 'error': str(exc), 'fields': []})

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

    unsupported = []
    supported_display = {'text', 'textbox', 'list', 'dropdown', 'radio', 'combobox', 'select', 'checkbox', 'boolean', 'yesno', 'yes/no', 'date', 'datepicker', 'textarea', 'text area', 'multiline', ''}
    for service in services:
        for f in service.get('fields', []):
            d = f['displayType'].strip().lower()
            if d not in supported_display and not any(x in d for x in ['text', 'date', 'number', 'list', 'select', 'check']):
                unsupported.append({'service': service['name'], 'field': f['name'], 'displayType': f['displayType']})

    plan = {
        'mode': 'PLAN_ONLY_NO_JIRA_WRITES',
        'serviceCount': len(services),
        'fieldOccurrences': sum(len(s.get('fields', [])) for s in services),
        'uniqueFieldNames': len(shared),
        'sharedReusableFieldNames': len(reusable),
        'typeConflictCount': len(conflicts),
        'unsupportedDisplayTypeCount': len(unsupported),
        'services': services,
        'sharedReusableFields': reusable,
        'typeConflicts': conflicts,
        'unsupportedDisplayTypes': unsupported,
        'proposedBuildOrder': [
            'read-only Jira inventory / target project validation',
            'reuse compatible existing Jira fields',
            'create missing shared fields and options',
            'create/reuse one issue type per offering',
            'create request types in the target JSM project',
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
        f"- Field occurrences: {plan['fieldOccurrences']}",
        f"- Unique field names: {plan['uniqueFieldNames']}",
        f"- Reusable shared field names: {plan['sharedReusableFieldNames']}",
        f"- Type conflicts: {plan['typeConflictCount']}",
        f"- Unsupported display types: {plan['unsupportedDisplayTypeCount']}", '',
        '## Services', '',
        '| Service | Fields | Required | Conditional | Select options |',
        '|---|---:|---:|---:|---:|',
    ]
    for s in services:
        fields = s.get('fields', [])
        lines.append(f"| {s['name']} | {len(fields)} | {sum(1 for f in fields if f['required'])} | {sum(1 for f in fields if f['conditional'])} | {sum(len(f['options']) for f in fields)} |")
    if conflicts:
        lines += ['', '## Field type conflicts', '']
        for c in conflicts:
            lines.append(f"- {c['name']}: {', '.join(c['types'])} across {', '.join(c['services'])}")
    if unsupported:
        lines += ['', '## Unsupported/unknown display types', '']
        for u in unsupported:
            lines.append(f"- {u['service']} / {u['field']}: {u['displayType']}")
    (OUT / 'jira-creation-plan.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    print(json.dumps({k: v for k, v in plan.items() if k not in {'services','sharedReusableFields','typeConflicts','unsupportedDisplayTypes','proposedBuildOrder'}}, indent=2))
    for s in services:
        print(f"{s['name']}: fields={len(s.get('fields', []))}")
    return 1 if any('error' in s for s in services) else 0


if __name__ == '__main__':
    raise SystemExit(main())
