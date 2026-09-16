#!/usr/bin/env python3
"""Static/source QA for the guarded IT Help completion runner."""
import json
import re
import sys
from pathlib import Path

ROOT = Path('.')
failures = []

def check(name, value):
    if not value:
        failures.append(name)

plan = json.loads((ROOT / 'migration-output/jira-creation-plan.json').read_text())
payload = json.loads((ROOT / 'migration-output/it-webtrigger/payload.json').read_text())
completion = payload.get('completionPlan') or {}
conditions = [
    (service['name'], field)
    for service in payload['services']
    for field in service.get('fields', [])
    if str(field.get('visibilityExpression') or '').strip()
]
check('exactly 14 source services', len(payload.get('services', [])) == 14 == plan.get('serviceCount'))
check('exactly 12 source visibility rules', len(conditions) == 12)
check('all conditional fields retain sourceName', all(field.get('sourceName') for _, field in conditions))
check('all conditional fields retain sourceId', all(field.get('sourceId') for _, field in conditions))
check('completion plan targets IT only', completion.get('target') == {'projectKey':'IT','projectId':'12789','serviceDeskId':'2183','workflowSchemeId':'12635'})
check('completion plan has 14 services', len(completion.get('services') or []) == 14)
check('completion plan has seven approval services', sum(bool(item.get('approval')) for item in completion.get('services') or []) == 7)
check('completion plan has eight exact orchestration services', sum(bool(item.get('tasks')) for item in completion.get('services') or []) == 8)
check('exact orchestration task count is source-backed', sum(len(item.get('tasks') or []) for item in completion.get('services') or []) == 54)
check('all exact orchestration tasks retain a source team', all(
    (item.get('routingTeam') and not item.get('taskRoutes')) or
    set(item.get('taskRoutes') or {}) == set(item.get('tasks') or [])
    for item in completion.get('services') or [] if item.get('tasks')
))

supported = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*\s*==\s*(?:"[^"]*"|\'[^\']*\'|true|false)$', re.I)
for service, field in conditions:
    expression = re.sub(r'\s+', ' ', field['visibilityExpression']).strip()
    expression = re.sub(r'^\$\(\s*|\)\s*$', '', expression).strip()
    match = re.match(r'^if\s+(.+?)\s+then\s+true\s+else\s+false$', expression, re.I)
    if match:
        expression = match.group(1)
    for clause in re.split(r'\s*\|\|\s*|\s*&&\s*', expression):
        check(f'supported expression: {service}/{field["name"]}/{clause}', supported.fullmatch(clause.strip()))

source = (ROOT / 'src/productionMigrationWebtrigger.ts').read_text()
engine = (ROOT / 'src/orchestrationGraphEngine.ts').read_text()
vector_graphs = (ROOT / 'src/vectorRoxGraphs.ts').read_text()
workflow = (ROOT / '.github/workflows/rim-it-webtrigger-forms.yml').read_text()
for anchor in [
    "const PROJECT_ID = '12789'", "const PROJECT_KEY = 'IT'", "const SERVICE_DESK_ID = '2183'",
    'parseVisibilityExpression', 'findPersistedQuestion', 'findChoiceToken', 'jiraOptionId',
    'conditions-readback', 'publish-readback', 'ensureLookupFallbackFields'
    , 'applyItWorkflowMappings', 'installSourceBackedOrchestration'
    , "statusId: '1'", "statusId: '4'", "newStatusId: '10121'", 'service.routingTeam'
]:
    check(f'runner anchor {anchor}', anchor in source)
check('workflow requires 12 persisted conditions', "parsed.get('conditions') != 12" in workflow)
check('workflow requires all 14 forms', "parsed.get('published') != 14" in workflow)
check('workflow requires zero unresolved lookups', "parsed.get('unresolvedFieldOccurrences') != 0" in workflow)
check('workflow requires all workflow mappings', 'mapped != 14' in workflow)
check('workflow requires eight exact orchestration plans', 'installed != 8' in workflow)
check('completion runner has no SD project target', not re.search(r"project(?:Key)?\s*[:=]\s*['\"]SD['\"]", source))
check('all four supplied Vector ROX graphs retained', all(name in vector_graphs for name in [
    'New Vector System Provisioning', 'Production Vector System Decommissioning',
    'Test Vector System Decommissioning', 'UAT Vector System Decommissioning'
]))
check('Vector parameter substitution retained', 'fieldMap' in vector_graphs and 'renderSourceTemplate' in (ROOT / 'src/orchestrationGraphEngine.ts').read_text())
check('structural fan-out recovery retained', 'repairStructuralFanout(plan,state)' in (ROOT / 'src/orchestrationGraphEngine.ts').read_text())
check('parent updates reconcile installed graphs', '!isCreated&&!isUpdated' in engine)

print(f'IT completion QA: {34 + len(conditions)} guarded checks')
if failures:
    print(f'FAILED: {len(failures)}')
    for failure in failures:
        print(' -', failure)
    sys.exit(1)
print('PASSED: source-backed Forms completion runner')
