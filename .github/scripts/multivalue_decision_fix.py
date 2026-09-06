#!/usr/bin/env python3
from pathlib import Path

engine = Path('src/orchestrationGraphEngine.ts')
text = engine.read_text()

old_field = "const actual=(await issue(parent.key)).fields?.[String(f.id)];const value=typeof actual==='object'&&actual&&'value'in actual?actual.value:actual;const eq=norm(value)===norm(expected);return /not|!=/i.test(m[2])?!eq:eq"
new_field = "const actual=(await issue(parent.key)).fields?.[String(f.id)];const values=Array.isArray(actual)?actual.map((item:any)=>typeof item==='object'&&item&&'value'in item?item.value:item):[typeof actual==='object'&&actual&&'value'in actual?actual.value:actual];const eq=values.some(value=>norm(value)===norm(expected));return /not|!=/i.test(m[2])?!eq:eq"
if old_field in text:
    text = text.replace(old_field, new_field, 1)
elif new_field not in text:
    raise SystemExit('Expected fieldValue implementation not found')

# Some migrated New Employee Setup ServiceDesk decisions retain explicit Yes/No routes but
# no parseable condition. Add a narrow fallback for this known workflow only. All unrelated
# unresolved decisions continue to hold for review.
old_tail = "if(!selected.length)continue;state.active=state.active.filter(x=>x!==id);"
fallback = "if(!selected.length&&norm(`${plan.serviceName} ${plan.workflowName}`).includes('new employee setup')){const edges=outgoing(plan,id);const yes=edges.find(e=>['true','yes'].includes(norm(e.outcome)));const no=edges.find(e=>['false','no'].includes(norm(e.outcome)));if(yes||no){const fields=await json<Array<{id?:string;name?:string}>>(await api.asApp().requestJira(route`/rest/api/3/field`,{headers:{Accept:'application/json'}}));const f=fields.find(x=>{const n=norm(x.name);return n.includes('service')&&n.includes('desk')});if(f?.id){const actual=(await issue(parent.key)).fields?.[String(f.id)];const values=Array.isArray(actual)?actual.map((item:any)=>typeof item==='object'&&item&&'value'in item?item.value:item):[typeof actual==='object'&&actual&&'value'in actual?actual.value:actual];const actualYes=values.some(value=>['yes','true','1','required','requested'].includes(norm(value)));const actualNo=values.some(value=>['no','false','0','not required','not requested'].includes(norm(value)));if(actualYes)selected=[yes].filter(Boolean) as GraphTransition[];else if(actualNo)selected=[no].filter(Boolean) as GraphTransition[]}}}if(!selected.length)continue;state.active=state.active.filter(x=>x!==id);"
if fallback not in text:
    if old_tail not in text:
        raise SystemExit('Expected decision completion guard not found')
    text = text.replace(old_tail, fallback, 1)
engine.write_text(text)

qa = Path('qa/browser/orchestration-transaction.spec.mjs')
text = qa.read_text()
old_setter = "  const payloadValue = meta?.schema?.type === 'array' ? [value] : value;\n  await apiJson(request, 'PUT', `/rest/api/3/issue/${key}`, { fields: { [field.id]: payloadValue } });"
new_setter = "  // The migrated Service Desk Support field is a Jira multi-value option field.\n  // Always send an array; editmeta does not consistently expose schema.type for this field.\n  await apiJson(request, 'PUT', `/rest/api/3/issue/${key}`, { fields: { [field.id]: [value] } });"
if old_setter in text:
    text = text.replace(old_setter, new_setter, 1)
elif new_setter not in text:
    raise SystemExit('Expected ServiceDesk QA setter not found')

pbx_marker = "runs ServiceDesk yes branch through PBX and final parent completion"
if pbx_marker not in text:
    insert = r'''

  test('runs ServiceDesk yes branch through PBX and final parent completion', async ({ request }) => {
    test.setTimeout(15 * 60 * 1000);
    let parentKey;
    try {
      const project = await apiJson(request, 'GET', `/rest/api/3/project/${projectKey}`, undefined);
      const issueType = (project?.issueTypes || []).find((type) => !type.subtask && norm(type.name) === norm(serviceName));
      expect(issueType?.id, `Expected a non-subtask Jira issue type named ${serviceName}`).toBeTruthy();
      const created = await apiJson(request, 'POST', '/rest/api/3/issue', { fields: { project: { key: projectKey }, issuetype: { id: String(issueType.id) }, summary: `[AUTO-QA] Ivanti PBX branch ${new Date().toISOString()}`, labels: ['ivanti-auto-qa'] } });
      parentKey = created.key;
      expect(parentKey).toBeTruthy();
      await setServiceDeskDecision(request, parentKey, 'Yes');
      const initial = await waitForSummaries(request, parentKey, ['Active Directory', 'Office 365']);
      for (const child of [...initial.values()].filter((item) => /active directory|office 365/i.test(item.fields.summary))) await doneTransition(request, child.key);
      const second = await waitForSummaries(request, parentKey, ['Firewall', 'Jira', 'Slack', 'Harvest']);
      const secondChildren = [...second.values()].filter((item) => ['firewall', 'jira', 'slack', 'harvest'].some((name) => norm(item.fields.summary).includes(name)));
      for (const child of secondChildren) await doneTransition(request, child.key);
      const withAssets = await waitForSummaries(request, parentKey, ['Assets']);
      const assets = [...withAssets.values()].filter((item) => norm(item.fields.summary).includes('assets'));
      expect(assets).toHaveLength(1);
      await doneTransition(request, assets[0].key);
      const withPbx = await waitForSummaries(request, parentKey, ['PBX']);
      const pbx = [...withPbx.values()].filter((item) => norm(item.fields.summary).includes('pbx'));
      expect(pbx, 'PBX must be created exactly once on the explicit ServiceDesk yes branch').toHaveLength(1);
      const beforePbxDone = await issue(request, parentKey);
      expect(norm(beforePbxDone?.fields?.status?.statusCategory?.key), 'Parent must remain open until PBX completes').not.toBe('done');
      await doneTransition(request, pbx[0].key);
      await waitForParentDone(request, parentKey);
      const completedChildren = await children(request, parentKey);
      const orchestration = completedChildren.filter((item) => (item.fields.labels || []).includes('ivanti-orchestration'));
      const counts = orchestration.reduce((acc, item) => { const key = norm(item.fields.summary); acc.set(key, (acc.get(key) || 0) + 1); return acc; }, new Map());
      expect([...counts.entries()].filter(([, count]) => count > 1), 'No orchestration node may create duplicate Jira subtasks').toEqual([]);
    } finally {
      if (parentKey) {
        const response = await request.delete(`/rest/api/3/issue/${parentKey}?deleteSubtasks=true`);
        if (!response.ok() && response.status() !== 404) console.warn(`QA cleanup could not delete ${parentKey}: ${response.status()}`);
      }
    }
  });
'''
    closing = '\n});\n'
    if not text.endswith(closing):
        raise SystemExit('Expected browser QA describe closing not found')
    text = text[:-len(closing)] + insert + closing
qa.write_text(text)

integrity = Path('.github/scripts/qa_source_integrity.py')
text = integrity.read_text()
if "multi-value decision fields supported" not in text:
    lines = text.splitlines()
    insert_at = next((i for i, line in enumerate(lines) if line.lstrip().startswith("check(") and "unsupported/" in line and "nodes hold" in line), None)
    if insert_at is None:
        insert_at = next((i for i, line in enumerate(lines) if line.lstrip().startswith("check(") and "stop node completes parent" in line), None)
    if insert_at is None:
        raise SystemExit('Expected source-integrity runtime safety insertion point not found')
    lines.insert(insert_at + 1, "check('multi-value decision fields supported', 'Array.isArray(actual)' in engine and 'values.some' in engine)")
    text = '\n'.join(lines) + ('\n' if text.endswith('\n') else '')

old_integrity = "check('ServiceDesk decision fallback retained', \"norm(node.title).includes('servicedesk')\" in engine and \"n.includes('service')&&n.includes('desk')\" in engine)"
new_integrity = "check('ServiceDesk decision fallback retained', \"norm(`${plan.serviceName} ${plan.workflowName}`).includes('new employee setup')\" in engine and \"n.includes('service')&&n.includes('desk')\" in engine)"
if old_integrity in text:
    text = text.replace(old_integrity, new_integrity, 1)
elif "ServiceDesk decision fallback retained" not in text:
    lines = text.splitlines()
    insert_at = next((i for i, line in enumerate(lines) if "multi-value decision fields supported" in line), None)
    if insert_at is None:
        raise SystemExit('Expected multi-value integrity check not found')
    lines.insert(insert_at + 1, new_integrity)
    text = '\n'.join(lines) + ('\n' if text.endswith('\n') else '')

if "PBX branch live QA retained" not in text:
    browser_tx = "browser_transaction = read('qa/browser/orchestration-transaction.spec.mjs')\n"
    anchor = "browser_qa = read('qa/browser/ivanti-live.spec.mjs')\n"
    if anchor in text and browser_tx not in text:
        text = text.replace(anchor, anchor + browser_tx, 1)
    coverage_anchor = "check('browser QA wired after deployment', 'Run authenticated Jira browser QA' in workflow)"
    if coverage_anchor not in text:
        raise SystemExit('Expected browser coverage insertion point not found')
    text = text.replace(coverage_anchor, coverage_anchor + "\ncheck('PBX branch live QA retained', 'runs ServiceDesk yes branch through PBX and final parent completion' in browser_transaction)", 1)

integrity.write_text(text)
print('Applied multi-value Ivanti decision support, New Employee Setup ServiceDesk fallback and PBX live proof')
