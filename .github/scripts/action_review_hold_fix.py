from pathlib import Path

engine_path = Path('src/orchestrationGraphEngine.ts')
engine = engine_path.read_text(encoding='utf-8')
old_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait')continue;"
new_hold = "if(node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||node.kind==='action')continue;"
if old_hold not in engine and new_hold not in engine:
    raise SystemExit('Expected orchestration review-hold guard not found')
engine = engine.replace(old_hold, new_hold, 1)
old_pass = "if(node.kind==='start'||node.kind==='action'){"
new_pass = "if(node.kind==='start'){"
if old_pass not in engine and new_pass not in engine:
    raise SystemExit('Expected start/action pass-through guard not found')
engine = engine.replace(old_pass, new_pass, 1)
engine_path.write_text(engine, encoding='utf-8')

qa_path = Path('.github/scripts/qa_source_integrity.py')
qa = qa_path.read_text(encoding='utf-8')
old_check = "check('unsupported/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'\" in engine)"
new_check = "check('unsupported/action/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'||node.kind==='action'\" in engine and \"node.kind==='start'||node.kind==='action'\" not in engine)"
if old_check not in qa and new_check not in qa:
    raise SystemExit('Expected source-integrity review-hold assertion not found')
qa = qa.replace(old_check, new_check, 1)
qa_path.write_text(qa, encoding='utf-8')

print('Applied safe review hold for unsupported action/wait/approval nodes')
