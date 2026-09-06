from pathlib import Path

engine_path = Path('src/orchestrationGraphEngine.ts')
engine = engine_path.read_text(encoding='utf-8')
old_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait')continue;"
legacy_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||node.kind==='action')continue;"
new_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||(node.kind==='action'&&!clean(node.actionKind)))continue;"
if legacy_hold in engine:
    engine = engine.replace(legacy_hold, new_hold, 1)
elif old_hold in engine:
    engine = engine.replace(old_hold, new_hold, 1)
elif new_hold not in engine:
    raise SystemExit('Expected orchestration review-hold guard not found')
legacy_pass = "if(node.kind==='start'){"
old_pass = "if(node.kind==='start'||node.kind==='action'){"
new_pass = "if(node.kind==='start'||(node.kind==='action'&&clean(node.actionKind))){"
if old_pass in engine:
    engine = engine.replace(old_pass, new_pass, 1)
elif legacy_pass in engine:
    engine = engine.replace(legacy_pass, new_pass, 1)
elif new_pass not in engine:
    raise SystemExit('Expected start/action routing guard not found')
engine_path.write_text(engine, encoding='utf-8')

qa_path = Path('.github/scripts/qa_source_integrity.py')
qa = qa_path.read_text(encoding='utf-8')
old_check = "check('unsupported/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'\" in engine)"
legacy_check = "check('unsupported/action/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||node.kind==='action'\" in engine and \"node.kind==='start'||node.kind==='action'\" not in engine)"
new_check = "check('unsupported/unresolved-action/wait/approval nodes hold', \"(node.kind==='action'&&!clean(node.actionKind))\" in engine and \"node.kind==='action'&&clean(node.actionKind)\" in engine)"
if legacy_check in qa:
    qa = qa.replace(legacy_check, new_check, 1)
elif old_check in qa:
    qa = qa.replace(old_check, new_check, 1)
elif new_check not in qa:
    raise SystemExit('Expected source-integrity review-hold assertion not found')
qa_path.write_text(qa, encoding='utf-8')

print('Applied safe review hold for unresolved actions while preserving known action routing')
