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

# CI #190 proved the No branch end-to-end but the Yes branch still stalled before PBX even after
# selecting the exact field by name. Do not maintain a second, subtly different Yes/No reader in
# the final completion guard. Reuse fieldValue(), whose exact-name lookup and multi-value handling
# are already exercised by the decision engine. This keeps the final safety path consistent with
# the normal graph semantics and removes the last duplicated field-decoding path.
old_final_probe = "const fields=await json<Array<{id?:string;name?:string}>>(await api.asApp().requestJira(route`/rest/api/3/field`,{headers:{Accept:'application/json'}}));const f=fields.find(x=>norm(x.name)==='service desk support')||fields.find(x=>norm(x.name)==='is service desk')||fields.find(x=>norm(x.name)==='isservicedesk')||fields.find(x=>{const n=norm(x.name);return n.includes('service')&&n.includes('desk')});if(f?.id){const actual=(await issue(parent.key)).fields?.[String(f.id)];const values=Array.isArray(actual)?actual.map((item:any)=>typeof item==='object'&&item&&'value'in item?item.value:item):[typeof actual==='object'&&actual&&'value'in actual?actual.value:actual];const yes=values.some(value=>['yes','true','1','required','requested'].includes(norm(value)));const no=values.some(value=>['no','false','0','not required','not requested'].includes(norm(value)));"
new_final_probe = "const yes=await fieldValue(parent,'Service Desk Support equals Yes');const no=await fieldValue(parent,'Service Desk Support equals No');if(yes!==undefined||no!==undefined){"
if old_final_probe in multi:
    multi = multi.replace(old_final_probe, new_final_probe, 1)
elif new_final_probe not in multi:
    raise SystemExit('Expected New Employee final ServiceDesk value probe not found')

old_integrity = "check('New Employee final branch guard retained', \"state.passed.includes(assets.id)\" in engine and \"addActive(state,[pbx.id])\" in engine and \"else if(no){state.completed=true;await transitionDone(parent.key)}\" in engine)"
new_integrity = "check('New Employee final branch guard retained', \"state.passed.includes(assets.id)\" in engine and \"fieldValue(parent,'Service Desk Support equals Yes')\" in engine and \"fieldValue(parent,'Service Desk Support equals No')\" in engine and \"addActive(state,[pbx.id])\" in engine and \"else if(no){state.completed=true;await transitionDone(parent.key)}\" in engine)"
if old_integrity in multi:
    multi = multi.replace(old_integrity, new_integrity, 1)
elif new_integrity not in multi:
    raise SystemExit('Expected New Employee final branch integrity assertion not found')

multi_path.write_text(multi, encoding='utf-8')

print('Applied review-flagged action routing, concurrency safety and unified Service Desk Support decision reading')
