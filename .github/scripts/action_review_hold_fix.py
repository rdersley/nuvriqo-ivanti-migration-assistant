from pathlib import Path

engine_path = Path('src/orchestrationGraphEngine.ts')
engine = engine_path.read_text(encoding='utf-8')
old_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait')continue;"
legacy_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||node.kind==='action')continue;"
narrow_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||(node.kind==='action'&&!clean(node.actionKind)))continue;"
new_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait')continue;"
if legacy_hold in engine:
    engine = engine.replace(legacy_hold, new_hold, 1)
elif narrow_hold in engine:
    engine = engine.replace(narrow_hold, new_hold, 1)
elif new_hold not in engine:
    raise SystemExit('Expected orchestration review-hold guard not found')
legacy_start = "if(node.kind==='start'){"
narrow_pass = "if(node.kind==='start'||(node.kind==='action'&&clean(node.actionKind))){"
new_pass = "if(node.kind==='start'||node.kind==='action'){"
if narrow_pass in engine:
    engine = engine.replace(narrow_pass, new_pass, 1)
elif legacy_start in engine:
    engine = engine.replace(legacy_start, new_pass, 1)
elif new_pass not in engine:
    raise SystemExit('Expected start/action routing guard not found')
engine_path.write_text(engine, encoding='utf-8')

qa_path = Path('.github/scripts/qa_source_integrity.py')
qa = qa_path.read_text(encoding='utf-8')
old_check = "check('unsupported/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'\" in engine)"
legacy_check = "check('unsupported/action/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||node.kind==='action'\" in engine and \"node.kind==='start'||node.kind==='action'\" not in engine)"
narrow_check = "check('unsupported/unresolved-action/wait/approval nodes hold', \"(node.kind==='action'&&!clean(node.actionKind))\" in engine and \"node.kind==='action'&&clean(node.actionKind)\" in engine)"
new_check = "check('unsupported/wait/approval nodes hold while actions remain review-routed', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'\" in engine and \"node.kind==='start'||node.kind==='action'\" in engine)"
if legacy_check in qa:
    qa = qa.replace(legacy_check, new_check, 1)
elif narrow_check in qa:
    qa = qa.replace(narrow_check, new_check, 1)
elif old_check in qa:
    qa = qa.replace(old_check, new_check, 1)
elif new_check not in qa:
    raise SystemExit('Expected source-integrity review-hold assertion not found')
qa_path.write_text(qa, encoding='utf-8')

# Jira can emit sibling subtask updates concurrently. Apply the monotonic state merge patch
# in the same pre-QA runtime patch stage so one invocation cannot erase another's progress.
exec(Path('.github/scripts/orchestration_state_merge_fix.py').read_text(encoding='utf-8'))

# CI #189 exposed two Jira fields containing "ServiceDesk": the migrated decision field
# "Service Desk Support" and an unrelated "Is user in ServiceDesk" field. The final-branch
# fallback previously selected the first broad name match, so it could read the unrelated field
# and never see the explicit Yes/No value used by the transaction QA. Tighten the selector in the
# next patch stage before it runs, while retaining a conservative fallback for older estates.
multi_path = Path('.github/scripts/multivalue_decision_fix.py')
multi = multi_path.read_text(encoding='utf-8')
old_selector = "const f=fields.find(x=>{const n=norm(x.name);return n.includes('service')&&n.includes('desk')});"
new_selector = "const f=fields.find(x=>norm(x.name)==='service desk support')||fields.find(x=>norm(x.name)==='is service desk')||fields.find(x=>norm(x.name)==='isservicedesk')||fields.find(x=>{const n=norm(x.name);return n.includes('service')&&n.includes('desk')});"
if old_selector in multi:
    multi = multi.replace(old_selector, new_selector)
elif new_selector not in multi:
    raise SystemExit('Expected ServiceDesk field selector not found')
multi_path.write_text(multi, encoding='utf-8')

print('Applied review-flagged action routing, concurrency safety and exact Service Desk Support selection')
