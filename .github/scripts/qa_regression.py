from pathlib import Path
import re
import sys

ROOT = Path('.')
failures = []
checks = []

def check(name, condition, detail=''):
    checks.append(name)
    if not condition:
        failures.append(f'{name}: {detail or "failed"}')

app = (ROOT / 'static/src/App.tsx').read_text()
backend = (ROOT / 'src/index.ts').read_text()
workflow = (ROOT / '.github/workflows/deploy-development.yml').read_text()
main = (ROOT / 'static/src/main.tsx').read_text()

# Core build safety
check('frontend type/build scripts exist', '"build": "tsc -b && vite build"' in (ROOT/'static/package.json').read_text())
check('Forge resolver backend exists', 'Resolver' in backend or 'resolver' in backend.lower())
check('safe orchestration build loaded', "import './safeOrchestrationBuild'" in main)

# Forms regression guards
check('Forms creation resolver retained', 'createJsmForm' in backend)
check('JSM request type resolver retained', 'createJsmRequestType' in backend)
check('Form publication/readback logic retained', 'published' in backend.lower() and 'form' in backend.lower())
for script in [
    'forms_condition_fix.py',
    'forms_condition_runtime_fix.py',
    'forms_condition_canonical_id_fix.py',
    'forms_condition_backend_controller_fix.py',
    'forms_persisted_section_controller_fix.py',
]:
    check(f'{script} exists', (ROOT/'.github/scripts'/script).exists())
    check(f'{script} runs in deploy', script in workflow)

# Orchestration regression guards (these are patched into App.tsx before this test runs)
check('orchestration React view present', 'Ivanti Workflow Orchestration Migration' in app)
check('8+ source evidence fallback present', 'workflowItems.length >= 8' in app)
check('fulfilment task classification present', "item.category === 'task'" in app)
check('join/gate classification present', 'all tasks? complete' in app)
check('source defects preserved', 'SOURCE DEFECT' in app)
check('compact parent lifecycle present', 'Submitted → Fulfilment → Completed / Cancelled' in app)
check('PBX conditional route present', 'PBX only on Yes' in app or 'create PBX only on Yes' in app)
check('execution plan present', 'Jira execution plan' in app)
check('Gate 1 present', 'Gate 1' in app)
check('Gate 2 present', 'Gate 2' in app)
check('Assets stage present', 'Create Assets work' in app)
check('ServiceDesk branch present', 'Evaluate ServiceDesk' in app)

# Orchestration sources must route through the protected implementation UI. The legacy
# workflow builder may remain available for genuinely status-based sources elsewhere.
check('orchestration safe boundary present', 'Safe orchestration boundary' in app)
check('orchestration implementation pack present', 'Fulfilment implementation pack' in app)
check('safe UI patch runs in deploy', 'orchestration_safe_ui_fix.py' in workflow)
check('orchestration does not map every block to statuses', 'Do not create a parent status for every Ivanti block' in app)

# Estate cutover assurance must remain available for every imported service.
check('cutover readiness patch exists', (ROOT/'.github/scripts/cutover_readiness_fix.py').exists())
check('cutover readiness patch runs in deploy', 'cutover_readiness_fix.py' in workflow)
check('cutover readiness page present', 'Cutover readiness' in app)
check('ready cutover state present', 'Ready to cut over' in app)
check('needs review cutover state present', 'Needs review' in app)
check('blocked cutover state present', "status = 'Blocked'" in app)
check('not migrated cutover state present', "status = 'Not migrated'" in app)
check('cutover CSV export present', 'exportCutoverReadinessCsv' in app and 'ivanti-jira-cutover-readiness.csv' in app)
check('orchestration screens treated as not required', "source:orchestrationSource ? 'Not required' : 'Required'" in app)
check('runtime signoff required before ready', "!['passed','approved'].includes(signoff)" in app)

# Deployment pipeline must run QA before build/deploy.
check('QA regression step wired', 'qa_regression.py' in workflow)

print(f'QA regression checks: {len(checks)} total')
if failures:
    print(f'FAILED: {len(failures)}')
    for failure in failures:
        print(f' - {failure}')
    sys.exit(1)
print('PASSED: all migration regression checks')
