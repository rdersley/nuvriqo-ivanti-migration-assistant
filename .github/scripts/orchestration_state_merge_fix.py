#!/usr/bin/env python3
from pathlib import Path

engine = Path('src/orchestrationGraphEngine.ts')
text = engine.read_text()
old = "async function saveState(s:State){s.updatedAt=new Date().toISOString();await kvs.set(stateKey(s.parentIssueId),s)}"
new = "async function saveState(s:State){const current=await kvs.get(stateKey(s.parentIssueId)) as State|undefined;if(current){s.createdTasks={...current.createdTasks,...s.createdTasks};s.passed=[...new Set([...current.passed,...s.passed])];s.active=[...new Set([...current.active,...s.active])].filter(id=>!s.passed.includes(id));s.completed=Boolean(current.completed||s.completed)}s.updatedAt=new Date().toISOString();await kvs.set(stateKey(s.parentIssueId),s)}"
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit('Expected saveState implementation not found')
engine.write_text(text)

integrity = Path('.github/scripts/qa_source_integrity.py')
qa = integrity.read_text()
marker = "check('monotonic orchestration state merge retained', '...current.createdTasks,...s.createdTasks' in engine and '...current.passed,...s.passed' in engine and 'current.completed||s.completed' in engine)"
if marker not in qa:
    anchor = "check('stop node completes parent', \"node.kind==='stop'\" in engine and 'transitionDone(parent.key)' in engine)"
    if anchor not in qa:
        raise SystemExit('Expected source-integrity insertion point not found')
    qa = qa.replace(anchor, anchor + '\n' + marker, 1)
integrity.write_text(qa)
print('Applied monotonic orchestration state merge for concurrent Jira child updates')
