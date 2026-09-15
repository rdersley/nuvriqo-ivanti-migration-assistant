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


def bool_expr(value):
    value = (value or '').strip().lower()
    return value in {'$(true)', 'true', '1', 'yes'}


def request_offering_fields(root):
    fields = []
    for node in descendants(root, 'ServiceRequestTemplateParameter'):
        display_name = text_of(node, 'DisplayName')
        internal_name = text_of(node, 'Name')
        display_type = text_of(node, 'DisplayType')
        if not (display_name or internal_name):
            continue
        options = []
        for option in descendants(node, 'ServiceRequestTemplateParameterValue'):
            value = text_of(option, 'ParameterValue')
            if value and value not in options:
                options.append(value)
        fields.append({
            'displayName': display_name or internal_name,
            'name': internal_name,
            'displayType': display_type,
            'required': bool_expr(text_of(node, 'RequiredExpression')),
            'visibilityExpression': text_of(node, 'VisibilityExpression'),
            'readOnlyExpression': text_of(node, 'ReadOnlyExpression'),
            'sequence': text_of(node, 'SequenceNumber'),
            'options': options[:250],
            'optionCount': len(options),
        })
    return fields


def parse_file(path: Path):
    result = {
        'file': path.name,
        'size': path.stat().st_size,
        'parseStatus': 'ok',
        'sourceKind': 'unknown',
        'serviceName': path.stem,
        'displayName': '',
        'description': '',
        'objectType': '',
        'fieldCount': 0,
        'requiredFieldCount': 0,
        'conditionalFieldCount': 0,
        'selectOptionCount': 0,
        'fields': [],
        'workflowBlocks': 0,
        'workflowEdges': 0,
        'quickActions': 0,
        'blockTypes': {},
        'triggerConditions': 0,
        'warnings': [],
    }
    try:
        root = ET.parse(path).getroot()
    except Exception as exc:
        result['parseStatus'] = 'failed'
        result['warnings'].append(f'Outer XML parse failed: {exc}')
        return result

    request_templates = descendants(root, 'ServiceRequestTemplate')
    if request_templates:
        result['sourceKind'] = 'ivanti-request-offering'
        template = request_templates[0]
        result['serviceName'] = text_of(template, 'Name') or result['serviceName']
        result['displayName'] = result['serviceName']
        result['description'] = text_of(template, 'Description')
        fields = request_offering_fields(template)
        result['fields'] = fields
        result['fieldCount'] = len(fields)
        result['requiredFieldCount'] = sum(1 for f in fields if f['required'])
        result['conditionalFieldCount'] = sum(1 for f in fields if f['visibilityExpression'])
        result['selectOptionCount'] = sum(f['optionCount'] for f in fields)

    wf_defs = descendants(root, 'WorkflowDefinition')
    wf_types = descendants(root, 'WorkflowType')
    if wf_defs:
        if result['sourceKind'] == 'unknown':
            result['sourceKind'] = 'ivanti-workflow-export'
        wf = wf_defs[0]
        result['serviceName'] = text_of(wf, 'Name') or result['serviceName']
        details = text_of(wf, 'Details')
        trigger_details = text_of(wf, 'TriggerDetails')
        inner = parse_inner_xml(details)
        if inner is None:
            result['warnings'].append('Workflow Details XML could not be parsed')
        else:
            blocks = descendants(inner, 'block')
            result['workflowBlocks'] = len(blocks)
            types = {}
            edges = 0
            for block in blocks:
                block_type = text_of(block, 'type').strip().lower() or 'unknown'
                types[block_type] = types.get(block_type, 0) + 1
                for ex in descendants(block, 'exit'):
                    edges += len(descendants(ex, 'link'))
            result['blockTypes'] = dict(sorted(types.items()))
            result['workflowEdges'] = edges
        trigger = parse_inner_xml(trigger_details)
        if trigger is not None:
            result['triggerConditions'] = len(descendants(trigger, 'group'))

    if wf_types:
        wt = wf_types[0]
        result['displayName'] = text_of(wt, 'DisplayName') or result['displayName']
        result['description'] = text_of(wt, 'Description') or result['description']
        result['objectType'] = text_of(wt, 'ObjectType')

    result['quickActions'] = len(descendants(root, 'QuickAction'))

    if result['sourceKind'] == 'unknown':
        result['warnings'].append('No supported Ivanti request offering or workflow definition was detected')
    if result['sourceKind'] == 'ivanti-request-offering' and result['fieldCount'] == 0:
        result['warnings'].append('Request offering contains no detected parameters')
    return result


def main():
    files = sorted(INPUT.glob('*.rox'))
    if not files:
        print('No .rox files found in migration-input', file=sys.stderr)
        return 2

    records = [parse_file(path) for path in files]
    failed = [r for r in records if r['parseStatus'] != 'ok']
    plan = {
        'mode': 'DRY_RUN_ONLY',
        'inputCount': len(records),
        'failedCount': len(failed),
        'totalBytes': sum(r['size'] for r in records),
        'requestOfferingCount': sum(1 for r in records if r['sourceKind'] == 'ivanti-request-offering'),
        'workflowExportCount': sum(1 for r in records if r['sourceKind'] == 'ivanti-workflow-export'),
        'totalFields': sum(r['fieldCount'] for r in records),
        'totalRequiredFields': sum(r['requiredFieldCount'] for r in records),
        'totalConditionalFields': sum(r['conditionalFieldCount'] for r in records),
        'totalSelectOptions': sum(r['selectOptionCount'] for r in records),
        'totalWorkflowBlocks': sum(r['workflowBlocks'] for r in records),
        'totalWorkflowEdges': sum(r['workflowEdges'] for r in records),
        'totalQuickActions': sum(r['quickActions'] for r in records),
        'files': records,
    }

    (OUT_DIR / 'migration-plan.json').write_text(json.dumps(plan, indent=2), encoding='utf-8')

    md = [
        '# Retail inMotion Ivanti migration dry-run',
        '',
        '**No Jira configuration is changed by this workflow.**',
        '',
        f"- ROX files: {plan['inputCount']}",
        f"- Parse failures: {plan['failedCount']}",
        f"- Request offerings detected: {plan['requestOfferingCount']}",
        f"- Workflow exports detected: {plan['workflowExportCount']}",
        f"- Fields detected: {plan['totalFields']}",
        f"- Required fields: {plan['totalRequiredFields']}",
        f"- Conditional fields: {plan['totalConditionalFields']}",
        f"- Select-list values: {plan['totalSelectOptions']}",
        f"- Workflow blocks detected: {plan['totalWorkflowBlocks']}",
        f"- Workflow edges detected: {plan['totalWorkflowEdges']}",
        f"- Quick actions detected: {plan['totalQuickActions']}",
        '',
        '| File | Service | Kind | Fields | Required | Conditional | Options | Blocks | Warnings |',
        '|---|---|---|---:|---:|---:|---:|---:|---|',
    ]
    for r in records:
        warnings = '; '.join(r['warnings']) if r['warnings'] else ''
        md.append(
            f"| {r['file']} | {r['serviceName']} | {r['sourceKind']} | {r['fieldCount']} | "
            f"{r['requiredFieldCount']} | {r['conditionalFieldCount']} | {r['selectOptionCount']} | "
            f"{r['workflowBlocks']} | {warnings} |"
        )
    (OUT_DIR / 'migration-plan.md').write_text('\n'.join(md) + '\n', encoding='utf-8')

    print(json.dumps({k: v for k, v in plan.items() if k != 'files'}, indent=2))
    for r in records:
        print(
            f"{r['file']}: {r['parseStatus']} kind={r['sourceKind']} fields={r['fieldCount']} "
            f"required={r['requiredFieldCount']} conditional={r['conditionalFieldCount']} "
            f"options={r['selectOptionCount']} blocks={r['workflowBlocks']} warnings={len(r['warnings'])}"
        )

    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
