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

# Prevent regression to dangerous workflow/status-centric build guidance for orchestration
orch_start = app.find('Ivanti Workflow Orchestration Migration')
orch_end = app.find('Raw workflow evidence', orch_start)
orch = app[orch_start:orch_end if orch_end > orch_start else len(app)] if orch_start >= 0 else ''
check('orchestration does not offer create v6 workflow', 'Create v6 workflow' not in orch)
check('orchestration does not map every block to statuses', 'Do not create a parent status for every Ivanti block' in orch)

# Deployment pipeline must run QA before build/deploy.
check('QA regression step wired', 'qa_regression.py' in workflow)

print(f'QA regression checks: {len(checks)} total')
if failures:
    print(f'FAILED: {len(failures)}')
    for failure in failures:
        print(f' - {failure}')
    sys.exit(1)
print('PASSED: all migration regression checks')
