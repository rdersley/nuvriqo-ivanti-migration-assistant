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
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
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

      const created = await apiJson(request, 'POST', '/rest/api/3/issue', {
        fields: {
          project: { key: projectKey },
          issuetype: { id: String(issueType.id) },
          summary: `[AUTO-QA] Ivanti PBX branch ${new Date().toISOString()}`,
          labels: ['ivanti-auto-qa']
        }
      });
      parentKey = created.key;
      expect(parentKey).toBeTruthy();
      await setServiceDeskDecision(request, parentKey, 'Yes');

      const initial = await waitForSummaries(request, parentKey, ['Active Directory', 'Office 365']);
      for (const child of [...initial.values()].filter((item) => /active directory|office 365/i.test(item.fields.summary))) {
        await doneTransition(request, child.key);
      }

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
      const counts = orchestration.reduce((acc, item) => {
        const key = norm(item.fields.summary);
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
      }, new Map());
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
needle = "check('unsupported/wait/approval nodes hold', \"node.kind==='unsupported'||node.kind==='approval'||node.kind==='wait'\" in engine)"
addition = needle + "\ncheck('multi-value decision fields supported', 'Array.isArray(actual)' in engine and 'values.some' in engine)"
if addition not in text:
    if needle not in text:
        raise SystemExit('Expected source-integrity insertion point not found')
    text = text.replace(needle, addition, 1)
if "PBX branch live QA retained" not in text:
    browser_tx = "browser_transaction = read('qa/browser/orchestration-transaction.spec.mjs')\n"
    anchor = "browser_qa = read('qa/browser/ivanti-live.spec.mjs')\n"
    if anchor in text and browser_tx not in text:
        text = text.replace(anchor, anchor + browser_tx, 1)
    coverage_anchor = "check('browser QA wired after deployment', 'Run authenticated Jira browser QA' in workflow)"
    coverage_add = coverage_anchor + "\ncheck('PBX branch live QA retained', 'runs ServiceDesk yes branch through PBX and final parent completion' in browser_transaction)"
    if coverage_anchor not in text:
        raise SystemExit('Expected browser coverage insertion point not found')
    text = text.replace(coverage_anchor, coverage_add, 1)
integrity.write_text(text)

print('Applied multi-value Ivanti decision field support and PBX live proof')
