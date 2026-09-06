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

# Jira can deliver sibling subtask updates at effectively the same time. A monotonic state
# merge prevents progress loss but does not by itself stop two invocations from both creating
# the same next-wave task before either mapping is persisted. Serialize reconciliation per
# parent with a short KVS lease. The write-then-settle-read ownership check makes competing
# invocations converge on a single lease owner before any Jira mutation is performed.
lock_anchor = "const planKey=(p:string,t:string)=>`${PLAN}:${p}:${t}`; const stateKey=(id:string)=>`${STATE}:${id}`;"
lock_replacement = lock_anchor + " const lockKey=(id:string)=>`ivanti-graph-lock-v1:${id}`;"
if lock_replacement not in text:
    if lock_anchor not in text:
        raise SystemExit('Expected orchestration key anchor not found')
    text = text.replace(lock_anchor, lock_replacement, 1)

sleep_anchor = "const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));"
lock_helper = """const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function withParentLock<T>(parentId:string,work:()=>Promise<T>):Promise<T>{const owner=`${Date.now()}-${Math.random().toString(36).slice(2)}`;for(let attempt=0;attempt<120;attempt++){const now=Date.now();const current=await kvs.get(lockKey(parentId)) as {owner?:string;expiresAt?:number}|undefined;if(!current||Number(current.expiresAt||0)<=now){await kvs.set(lockKey(parentId),{owner,expiresAt:now+120000});await sleep(200);const check=await kvs.get(lockKey(parentId)) as {owner?:string}|undefined;if(check?.owner===owner){try{return await work()}finally{const latest=await kvs.get(lockKey(parentId)) as {owner?:string}|undefined;if(latest?.owner===owner)await kvs.delete(lockKey(parentId))}}}await sleep(250)}throw new Error(`Timed out acquiring orchestration lock for ${parentId}`)}"""
if lock_helper not in text:
    if sleep_anchor not in text:
        raise SystemExit('Expected orchestration sleep anchor not found')
    text = text.replace(sleep_anchor, lock_helper, 1)

old_tail = "await reconcile(plan,parent);if(isSubtask){for(const delay of [2500,5000]){await sleep(delay);const freshParent=await issue(parent.key);await reconcile(plan,freshParent)}}}"
new_tail = "await withParentLock(String(parent.id),async()=>{const freshParent=await issue(parent.key);await reconcile(plan,freshParent);if(isSubtask){await sleep(1500);await reconcile(plan,await issue(parent.key))}})}"
if new_tail not in text:
    if old_tail not in text:
        raise SystemExit('Expected orchestration event reconciliation tail not found')
    text = text.replace(old_tail, new_tail, 1)

engine.write_text(text)

integrity = Path('.github/scripts/qa_source_integrity.py')
qa = integrity.read_text()
merge_marker = "check('monotonic orchestration state merge retained', '...current.createdTasks,...s.createdTasks' in engine and '...current.passed,...s.passed' in engine and 'current.completed||s.completed' in engine)"
if merge_marker not in qa:
    anchor = "check('stop node completes parent', \"node.kind==='stop'\" in engine and 'transitionDone(parent.key)' in engine)"
    if anchor not in qa:
        raise SystemExit('Expected source-integrity insertion point not found')
    qa = qa.replace(anchor, anchor + '\n' + merge_marker, 1)
lock_marker = "check('parent orchestration reconciliation is serialized', 'withParentLock(String(parent.id)' in engine and 'ivanti-graph-lock-v1:' in engine and 'await kvs.delete(lockKey(parentId))' in engine)"
if lock_marker not in qa:
    qa = qa.replace(merge_marker, merge_marker + '\n' + lock_marker, 1)
integrity.write_text(qa)
print('Applied monotonic state merge and per-parent reconciliation lock for concurrent Jira child updates')
