#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'migration-output'
PLAN = OUT / 'jira-creation-plan.json'
INV = OUT / 'jira-inventory' / 'inventory.json'
REC = OUT / 'jira-reconciliation'
REC.mkdir(parents=True, exist_ok=True)

plan = json.loads(PLAN.read_text(encoding='utf-8'))
inv = json.loads(INV.read_text(encoding='utf-8'))


def norm(v):
    return ' '.join((v or '').lower().split())

existing_by_name = {}
for f in inv.get('fields', []):
    existing_by_name.setdefault(norm(f.get('name')), []).append(f)

planned = {}
for svc in plan.get('services', []):
    for f in svc.get('fields', []):
        key = norm(f.get('name'))
        if not key:
            continue
        item = planned.setdefault(key, {
            'name': f.get('name'),
            'plannedTypes': set(),
            'services': set(),
            'occurrences': 0,
        })
        item['plannedTypes'].add(f.get('jiraType'))
        item['services'].add(svc.get('name'))
        item['occurrences'] += 1

matches = []
missing = []
review = []
for key, p in sorted(planned.items()):
    existing = existing_by_name.get(key, [])
    row = {
        'name': p['name'],
        'plannedTypes': sorted(x for x in p['plannedTypes'] if x),
        'services': sorted(x for x in p['services'] if x),
        'occurrences': p['occurrences'],
        'existing': existing,
    }
    if not existing:
        missing.append(row)
    elif len(existing) == 1:
        matches.append(row)
    else:
        review.append(row)

service_projects = [p for p in inv.get('projects', []) if p.get('projectTypeKey') in {'service_desk', 'customer_service'}]
keywords = ('it', 'service', 'support', 'help', 'desk', 'request')
for p in service_projects:
    text = f"{p.get('key','')} {p.get('name','')}".lower()
    p['migrationCandidateScore'] = sum(1 for k in keywords if k in text)
service_projects.sort(key=lambda x: (-x.get('migrationCandidateScore', 0), x.get('name', '')))

result = {
    'mode': 'RECONCILIATION_ONLY_NO_JIRA_WRITES',
    'plannedUniqueFieldNames': len(planned),
    'exactExistingFieldNameMatches': len(matches),
    'missingFieldNames': len(missing),
    'duplicateExistingFieldNameReviews': len(review),
    'candidateServiceProjects': service_projects,
    'exactMatches': matches,
    'missingFields': missing,
    'duplicateNameReviews': review,
    'blockingSourceTypeConflicts': plan.get('typeConflicts', []),
    'lookupBackedFields': plan.get('lookupBackedFields', []),
}

(REC / 'reconciliation.json').write_text(json.dumps(result, indent=2), encoding='utf-8')

lines = [
    '# Retail inMotion Jira migration reconciliation', '',
    '**READ ONLY — no Jira configuration has been changed.**', '',
    f"- Planned unique field names: {result['plannedUniqueFieldNames']}",
    f"- Exact existing Jira field-name matches: {result['exactExistingFieldNameMatches']}",
    f"- Missing field names: {result['missingFieldNames']}",
    f"- Existing duplicate-name reviews: {result['duplicateExistingFieldNameReviews']}",
    f"- Source field-name/type conflicts requiring safe split: {len(result['blockingSourceTypeConflicts'])}", '',
    '## Candidate JSM projects visible to the migration account', '',
    '| Key | Name | Type | Score |',
    '|---|---|---|---:|',
]
for p in service_projects:
    lines.append(f"| {p.get('key','')} | {p.get('name','')} | {p.get('projectTypeKey','')} | {p.get('migrationCandidateScore',0)} |")

if matches:
    lines += ['', '## Existing field names that can be evaluated for reuse', '']
    for r in matches:
        e = r['existing'][0]
        lines.append(f"- {r['name']} → {e.get('id')} ({e.get('schemaType') or 'unknown schema'})")
if missing:
    lines += ['', '## Field names not currently present', '']
    for r in missing:
        lines.append(f"- {r['name']} ({', '.join(r['plannedTypes'])})")
if review:
    lines += ['', '## Duplicate existing field names requiring explicit selection', '']
    for r in review:
        ids = ', '.join(f"{e.get('id')}:{e.get('schemaType') or 'unknown'}" for e in r['existing'])
        lines.append(f"- {r['name']} → {ids}")
if result['blockingSourceTypeConflicts']:
    lines += ['', '## Source same-name/different-type fields — keep service-specific', '']
    for c in result['blockingSourceTypeConflicts']:
        lines.append(f"- {c.get('name')}: {', '.join(c.get('types', []))} across {', '.join(c.get('services', []))}; do not reuse one Jira field across these services")

(REC / 'reconciliation.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')

print(json.dumps({
    'mode': result['mode'],
    'plannedUniqueFieldNames': result['plannedUniqueFieldNames'],
    'exactExistingFieldNameMatches': result['exactExistingFieldNameMatches'],
    'missingFieldNames': result['missingFieldNames'],
    'duplicateExistingFieldNameReviews': result['duplicateExistingFieldNameReviews'],
    'candidateServiceProjectCount': len(service_projects),
    'sourceTypeConflictCount': len(result['blockingSourceTypeConflicts']),
}, indent=2))
