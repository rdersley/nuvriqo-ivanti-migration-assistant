#!/usr/bin/env python3
from pathlib import Path

engine = Path('src/orchestrationGraphEngine.ts')
text = engine.read_text()
old = "const actual=(await issue(parent.key)).fields?.[String(f.id)];const value=typeof actual==='object'&&actual&&'value'in actual?actual.value:actual;const eq=norm(value)===norm(expected);return /not|!=/i.test(m[2])?!eq:eq"
new = "const actual=(await issue(parent.key)).fields?.[String(f.id)];const values=Array.isArray(actual)?actual.map((item:any)=>typeof item==='object'&&item&&'value'in item?item.value:item):[typeof actual==='object'&&actual&&'value'in actual?actual.value:actual];const eq=values.some(value=>norm(value)===norm(expected));return /not|!=/i.test(m[2])?!eq:eq"
if old not in text:
    if new not in text:
        raise SystemExit('Expected fieldValue implementation not found')
else:
    engine.write_text(text.replace(old, new, 1))

qa = Path('qa/browser/orchestration-transaction.spec.mjs')
text = qa.read_text()
old = "  const payloadValue = meta?.schema?.type === 'array' ? [value] : value;\n  await apiJson(request, 'PUT', `/rest/api/3/issue/${key}`, { fields: { [field.id]: payloadValue } });"
new = "  // The migrated Service Desk Support field is a Jira multi-value option field.\n  // Always send an array; editmeta does not consistently expose schema.type for this field.\n  await apiJson(request, 'PUT', `/rest/api/3/issue/${key}`, { fields: { [field.id]: [value] } });"
if old not in text:
    if new not in text:
        raise SystemExit('Expected ServiceDesk QA setter not found')
else:
    qa.write_text(text.replace(old, new, 1))

integrity = Path('.github/scripts/qa_source_integrity.py')
text = integrity.read_text()
needle = "check('unsupported/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'\" in engine)"
addition = needle + "\ncheck('multi-value decision fields supported', 'Array.isArray(actual)' in engine and 'values.some' in engine)"
if addition not in text:
    if needle not in text:
        raise SystemExit('Expected source-integrity insertion point not found')
    integrity.write_text(text.replace(needle, addition, 1))

print('Applied multi-value Ivanti decision field support')
