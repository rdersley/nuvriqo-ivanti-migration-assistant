#!/usr/bin/env python3
"""Cross-file source integrity regression checks for the Ivanti migration app.

These checks deliberately cover several important implementation files so changes in one
area cannot silently remove the runtime, form-repair, compiler or trigger protections
that the live migration depends on.
"""
from pathlib import Path
import sys

ROOT = Path('.')
failures = []
checks = []

def read(path: str) -> str:
    p = ROOT / path
    if not p.exists():
        failures.append(f'{path}: file missing')
        return ''
    return p.read_text(encoding='utf-8')

def check(name: str, condition: bool, detail: str = '') -> None:
    checks.append(name)
    if not condition:
        failures.append(f'{name}: {detail or "failed"}')

manifest = read('manifest.yml')
combined = read('src/combined.ts')
engine = read('src/orchestrationGraphEngine.ts')
repair = read('src/formRepair.ts')
compiler = read('static/src/ivantiGraphCompiler.ts')
compiler_mount = read('static/src/WorkflowGraphCompilerMount.tsx')
workflow_import = read('static/src/WorkflowXmlImportMount.tsx')
browser_qa = read('qa/browser/ivanti-live.spec.mjs')
workflow = read('.github/workflows/deploy-development.yml')

# Forge wiring
check('Jira created trigger retained', 'avi:jira:created:issue' in manifest)
check('Jira updated trigger retained', 'avi:jira:updated:issue' in manifest)
check('graph event handler wired', 'orchestrationGraphEngine.handleGraphIssueEvent' in manifest)
check('combined resolver wired', 'handler: combined.handler' in manifest)
check('graph save resolver exposed', "'saveExecutableGraph'" in combined and "define('saveExecutableGraph'" in combined)
check('graph target resolver exposed', "'resolveGraphInstallTarget'" in combined and "define('resolveGraphInstallTarget'" in combined)
check('form repair resolver exposed', "'repairMigratedForms'" in combined and "define('repairMigratedForms'" in combined)

# Runtime engine safety
check('graph plan v2 key retained', "ivanti-executable-graph-v2" in engine)
check('graph state v2 key retained', "ivanti-graph-state-v2" in engine)
check('subtasks retain parent relationship', 'parent:{key:state.parentIssueKey}' in engine)
check('orchestration subtasks labelled', "'ivanti-orchestration'" in engine)
check('child create events ignored', 'if(isCreated)return' in engine)
check('parent updates ignored', 'if(!isCreated)return' in engine)
check('child updates wait for Done category', "cat!=='done'" in engine)
check('pre-install issues are ignored', 'createdAt<installedAt' in engine)
check('unsupported/wait/approval nodes hold', "node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'" in engine)
check('stop node completes parent', "node.kind==='stop'" in engine and 'transitionDone(parent.key)' in engine)

# Form repair fidelity
for helper in ['dept manager display name', 'facility detail', 'new employee information', 'equipment details', 'imagefield']:
    check(f'helper hidden: {helper}', helper in repair)
check('migration form suffix matching retained', 'ivanti migration form' in repair)
check('Hiring Manager converted to text when needed', "key === 'hiring manager'" in repair and "type: 'ts'" in repair)
check('publish schema preserved exactly', 'if (stored.publish) body.publish = stored.publish' in repair)
check('repair edits live form in place', "method: 'PUT'" in repair and '/forms/project/${projectId}/form/${form.id}' in repair)

# Workflow parser/compiler fidelity
check('XML workflow parser retained', 'parseOuterXml' in workflow_import)
check('GetInstance parser retained', 'parseGetInstance' in workflow_import)
check('quick action child semantics retained', "kind: 'child-work-item'" in workflow_import)
check('email quick action semantics retained', "kind: 'email'" in workflow_import)
check('reachable broken exits retained as defects', 'reachable unconnected' in workflow_import)
check('task/create compiles as task', "value === 'task' || value === 'create'" in compiler)
check('join compiles as gate', "value === 'join'" in compiler)
check('if/switch/decision compile as decision', "['if', 'switch', 'decision']" in compiler)
check('waitforchild compiles as wait', 'waitforchild' in compiler)
check('unsupported blocks retained', "return 'unsupported'" in compiler)
check('compiler preserves source defects', 'workflow.workflow.derived.defects' in compiler)
check('compiler uses connected exits', 'for (const targetId of exit.links)' in compiler)
check('install resolves real Jira target', "invoke('resolveGraphInstallTarget'" in compiler_mount)
check('install saves executable graph', "invoke('saveExecutableGraph'" in compiler_mount)
check('compiler warns instead of guessing blockers', 'will hold the process for review rather than being skipped' in compiler_mount)

# Browser and CI coverage
check('authenticated browser QA file present', bool(browser_qa))
check('browser checks migrated form attachment', 'New Employee Setup - Ivanti Migration Form' in browser_qa)
check('browser checks hidden helper fields', 'dept manager display name' in browser_qa and 'imageField' in browser_qa)
check('browser checks key migrated fields', 'Hiring Manager' in browser_qa and 'Computer Required' in browser_qa and 'Start Date' in browser_qa)
check('runtime simulation wired before deployment', 'qa_orchestration_runtime.py' in workflow)
check('source integrity QA wired before deployment', 'qa_source_integrity.py' in workflow)
check('browser QA wired after deployment', 'Run authenticated Jira browser QA' in workflow)

print(f'Source integrity QA checks: {len(checks)} total')
if failures:
    print(f'FAILED: {len(failures)}')
    for failure in failures:
        print(f' - {failure}')
    sys.exit(1)
print('PASSED: all cross-file source integrity checks')
