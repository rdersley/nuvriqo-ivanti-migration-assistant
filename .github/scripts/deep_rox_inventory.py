#!/usr/bin/env python3
import csv, json, re
from collections import Counter, defaultdict
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / 'migration-input'
OUT = ROOT / 'migration-output' / 'deep-rox-inventory'
OUT.mkdir(parents=True, exist_ok=True)

GUID_RE = re.compile(r'^[0-9a-fA-F]{32}$')

def local(tag):
    return tag.split('}')[-1]

def txt(node):
    return (node.text or '').strip()

def child_text(node, name):
    for child in list(node):
        if local(child.tag).lower() == name.lower():
            return txt(child)
    return ''

def clean(value):
    value = re.sub(r'<br\s*/?>', ' ', value or '', flags=re.I)
    value = re.sub(r'<[^>]+>', '', value)
    value = value.replace('&nbsp;', ' ').replace('&amp;', '&')
    return re.sub(r'\s+', ' ', value).strip()

def descendants(root, name):
    n = name.lower()
    return [e for e in root.iter() if local(e.tag).lower() == n]

services = []
all_tags = Counter()
all_values = defaultdict(set)
all_guids = defaultdict(set)
field_rows = []
reference_rows = []
expression_rows = []
parameter_value_rows = []

for path in sorted(INPUT.glob('*.rox')):
    root = ET.parse(path).getroot()
    for e in root.iter():
        tag = local(e.tag)
        all_tags[tag] += 1
        value = txt(e)
        if value:
            if len(all_values[tag]) < 5000:
                all_values[tag].add(value)
            if GUID_RE.fullmatch(value):
                all_guids[value.lower()].add((path.name, tag))
        for ak, av in e.attrib.items():
            if GUID_RE.fullmatch(str(av).strip()):
                all_guids[str(av).strip().lower()].add((path.name, f'@{ak}'))

    templates = descendants(root, 'ServiceRequestTemplate')
    t = templates[0] if templates else None
    name = child_text(t, 'Name') if t is not None else path.stem
    description = clean(child_text(t, 'Description')) if t is not None else ''
    svc = {
        'sourceFile': path.name,
        'name': name or path.stem,
        'description': description,
        'status': child_text(t, 'Status') if t is not None else '',
        'templateRecId': child_text(t, 'RecId') if t is not None else '',
        'serviceRecId': child_text(t, 'ServiceRecId') if t is not None else '',
        'deliveryCommitment': child_text(t, 'DeliveryCommitment') if t is not None else '',
        'defaultAssigneeTeam': child_text(t, 'DefaultAssigneeTeam') if t is not None else '',
        'defaultAssignee': child_text(t, 'DefaultAssignee') if t is not None else '',
        'configOptions': child_text(t, 'ConfigOptions') if t is not None else '',
        'fieldCount': 0,
        'sectionCount': 0,
        'conditionCount': 0,
        'lookupCount': 0,
        'embeddedOptionCount': 0,
        'tagCounts': Counter(local(e.tag) for e in root.iter()),
    }

    for p in descendants(root, 'ServiceRequestTemplateParameter'):
        display = child_text(p, 'DisplayName') or child_text(p, 'Name')
        if not display:
            continue
        display_type = child_text(p, 'DisplayType')
        vis = child_text(p, 'VisibilityExpression')
        req = child_text(p, 'RequiredExpression')
        lookup = child_text(p, 'ValidationListRecId')
        options = []
        for item in descendants(p, 'ServiceRequestTemplateParameterValue'):
            v = child_text(item, 'ParameterValue')
            if v and v not in options:
                options.append(v)
                parameter_value_rows.append({
                    'service': svc['name'], 'field': display, 'value': v,
                    'parameterRecId': child_text(p, 'RecId')
                })
        is_section = display_type.lower().strip() == 'category'
        svc['sectionCount' if is_section else 'fieldCount'] += 1
        if vis and vis.strip().lower() not in {'false', '$(false)'}:
            svc['conditionCount'] += 1
            expression_rows.append({
                'service': svc['name'], 'field': display, 'kind': 'visibility',
                'expression': vis, 'sourceId': child_text(p, 'RecId')
            })
        if req:
            expression_rows.append({
                'service': svc['name'], 'field': display, 'kind': 'required',
                'expression': req, 'sourceId': child_text(p, 'RecId')
            })
        if lookup:
            svc['lookupCount'] += 1
            reference_rows.append({
                'service': svc['name'], 'field': display, 'referenceType': 'ValidationListRecId',
                'referenceId': lookup, 'sourceId': child_text(p, 'RecId')
            })
        svc['embeddedOptionCount'] += len(options)
        field_rows.append({
            'service': svc['name'], 'sourceFile': path.name,
            'sourceId': child_text(p, 'RecId'),
            'name': display,
            'sourceName': child_text(p, 'Name'),
            'displayType': display_type,
            'sequence': child_text(p, 'SequenceNumber'),
            'description': clean(child_text(p, 'Description')),
            'requiredExpression': req,
            'visibilityExpression': vis,
            'validationListRecId': lookup,
            'defaultValue': child_text(p, 'DefaultValue'),
            'adHocValues': child_text(p, 'AdHocValues'),
            'embeddedOptionCount': len(options),
            'embeddedOptions': ' | '.join(options),
        })

    # Capture every GUID-like relation carried by named XML elements.
    for e in root.iter():
        value = txt(e)
        if GUID_RE.fullmatch(value):
            reference_rows.append({
                'service': svc['name'], 'field': '', 'referenceType': local(e.tag),
                'referenceId': value, 'sourceId': ''
            })

    services.append(svc)

# Cross-reference GUIDs that appear in more than one source location.
cross_refs = []
for guid, locations in sorted(all_guids.items()):
    locs = sorted(locations)
    cross_refs.append({
        'id': guid,
        'occurrences': len(locs),
        'files': sorted({f for f, _ in locs}),
        'tags': sorted({t for _, t in locs}),
    })

summary = {
    'roxFiles': len(services),
    'services': [
        {k: (dict(v) if isinstance(v, Counter) else v) for k, v in s.items()}
        for s in services
    ],
    'totalFields': sum(s['fieldCount'] for s in services),
    'totalSections': sum(s['sectionCount'] for s in services),
    'totalConditionalParameters': sum(s['conditionCount'] for s in services),
    'totalLookupReferences': sum(s['lookupCount'] for s in services),
    'totalEmbeddedOptions': sum(s['embeddedOptionCount'] for s in services),
    'uniqueXmlTags': len(all_tags),
    'xmlTagCounts': dict(all_tags.most_common()),
    'guidLikeIdentifiers': len(cross_refs),
    'sharedGuidIdentifiers': sum(1 for r in cross_refs if len(r['files']) > 1),
}

(OUT / 'deep-rox-summary.json').write_text(json.dumps(summary, indent=2, default=str), encoding='utf-8')
(OUT / 'guid-cross-reference.json').write_text(json.dumps(cross_refs, indent=2), encoding='utf-8')
(OUT / 'tag-values.json').write_text(json.dumps({k: sorted(v) for k, v in all_values.items()}, indent=2), encoding='utf-8')

def write_csv(name, rows):
    rows = list(rows)
    if not rows:
        return
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    with (OUT / name).open('w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader(); w.writerows(rows)

write_csv('fields.csv', field_rows)
write_csv('expressions.csv', expression_rows)
write_csv('references.csv', reference_rows)
write_csv('embedded-options.csv', parameter_value_rows)
write_csv('guid-cross-reference.csv', [
    {'id': r['id'], 'occurrences': r['occurrences'], 'files': ';'.join(r['files']), 'tags': ';'.join(r['tags'])}
    for r in cross_refs
])
write_csv('service-summary.csv', [
    {k: v for k, v in s.items() if k != 'tagCounts'} for s in services
])

print(json.dumps({
    'roxFiles': summary['roxFiles'],
    'totalFields': summary['totalFields'],
    'totalSections': summary['totalSections'],
    'totalConditionalParameters': summary['totalConditionalParameters'],
    'totalLookupReferences': summary['totalLookupReferences'],
    'totalEmbeddedOptions': summary['totalEmbeddedOptions'],
    'uniqueXmlTags': summary['uniqueXmlTags'],
    'guidLikeIdentifiers': summary['guidLikeIdentifiers'],
    'sharedGuidIdentifiers': summary['sharedGuidIdentifiers'],
}, indent=2))
