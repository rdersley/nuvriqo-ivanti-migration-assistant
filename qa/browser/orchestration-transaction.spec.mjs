import { test, expect } from '@playwright/test';

const projectKey = process.env.QA_PROJECT_KEY || 'DEMO';
const serviceName = process.env.QA_SERVICE_NAME || 'New Employee Setup';
const pollMs = Number(process.env.QA_ORCHESTRATION_POLL_MS || 10000);
const waitMs = Number(process.env.QA_ORCHESTRATION_WAIT_MS || 210000);

async function apiJson(request, method, path, body) {
  const response = await request.fetch(path, {
    method,
    data: body,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()}: ${typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500)}`);
  return parsed;
}

async function issue(request, key) {
  return apiJson(request, 'GET', `/rest/api/3/issue/${key}?fields=summary,status,subtasks,labels,parent,issuetype`, undefined);
}

async function children(request, parentKey) {
  const parent = await issue(request, parentKey);
  const refs = parent?.fields?.subtasks || [];
  const full = [];
  for (const ref of refs) full.push(await issue(request, ref.key));
  return full;
}

function norm(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function setServiceDeskDecision(request, key, choice) {
  const fields = await apiJson(request, 'GET', '/rest/api/3/field', undefined);
  const field = (fields || []).find((item) => norm(item?.name) === 'isservicedesk')
    || (fields || []).find((item) => norm(item?.name) === 'is service desk')
    || (fields || []).find((item) => norm(item?.name).includes('service desk'));
  expect(field?.id, 'Expected a Jira field for the migrated ServiceDesk decision').toBeTruthy();

  const editMeta = await apiJson(request, 'GET', `/rest/api/3/issue/${key}/editmeta`, undefined);
  const meta = editMeta?.fields?.[field.id];
  const allowed = meta?.allowedValues || [];
  const option = allowed.find((value) => norm(value?.value ?? value?.name) === norm(choice));
  let value;
  if (option?.id) value = { id: String(option.id) };
  else if (allowed.length) throw new Error(`ServiceDesk field does not offer ${choice}. Allowed: ${allowed.map((v) => v?.value ?? v?.name ?? v?.id).join(', ')}`);
  else value = { value: choice };

  const payloadValue = meta?.schema?.type === 'array' ? [value] : value;
  await apiJson(request, 'PUT', `/rest/api/3/issue/${key}`, { fields: { [field.id]: payloadValue } });
}

async function waitFor(request, description, predicate, timeout = waitMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${description}. Last observation: ${JSON.stringify(last)}`);
}

async function doneTransition(request, key) {
  const data = await apiJson(request, 'GET', `/rest/api/3/issue/${key}/transitions?expand=transitions.fields`, undefined);
  const transitions = data?.transitions || [];
  const chosen = transitions.find((t) => norm(t?.to?.statusCategory?.key) === 'done')
    || transitions.find((t) => /done|complete|resolve|close/i.test(`${t?.name || ''} ${t?.to?.name || ''}`));
  if (!chosen?.id) throw new Error(`No Done-category transition available for ${key}. Available: ${transitions.map((t) => `${t.name}->${t?.to?.name}`).join(', ')}`);
  await apiJson(request, 'POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: String(chosen.id) } });
}

async function bySummary(request, parentKey) {
  const list = await children(request, parentKey);
  return new Map(list.map((item) => [norm(item?.fields?.summary), item]));
}

async function waitForSummaries(request, parentKey, expected) {
  return waitFor(request, expected.join(', '), async () => {
    const map = await bySummary(request, parentKey);
    const found = expected.map((name) => [...map.keys()].find((summary) => summary.includes(norm(name))));
    if (found.every(Boolean)) return map;
    return null;
  });
}

async function waitForParentDone(request, parentKey) {
  return waitFor(request, `${parentKey} to reach Done`, async () => {
    const parent = await issue(request, parentKey);
    return norm(parent?.fields?.status?.statusCategory?.key) === 'done' ? parent : null;
  });
}

test.describe('Ivanti orchestration - live transactional Jira QA', () => {
  test.describe.configure({ retries: 0 });

  test('runs New Employee Setup through both gates, Assets and explicit no-ServiceDesk completion without duplicates', async ({ request }) => {
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
          summary: `[AUTO-QA] Ivanti orchestration ${new Date().toISOString()}`,
          labels: ['ivanti-auto-qa']
        }
      });
      parentKey = created.key;
      expect(parentKey).toBeTruthy();
      await setServiceDeskDecision(request, parentKey, 'No');

      const initial = await waitForSummaries(request, parentKey, ['Active Directory', 'Office 365']);
      const initialChildren = [...initial.values()];
      expect(initialChildren.filter((item) => /active directory/i.test(item.fields.summary))).toHaveLength(1);
      expect(initialChildren.filter((item) => /office 365/i.test(item.fields.summary))).toHaveLength(1);

      const ad = initialChildren.find((item) => /active directory/i.test(item.fields.summary));
      const o365 = initialChildren.find((item) => /office 365/i.test(item.fields.summary));
      await doneTransition(request, ad.key);

      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, pollMs * 2)));
      const beforeGate = await children(request, parentKey);
      for (const name of ['Firewall', 'Jira', 'Slack', 'Harvest']) {
        expect(beforeGate.some((item) => norm(item.fields.summary).includes(norm(name))), `${name} appeared before both initial tasks completed`).toBeFalsy();
      }

      await doneTransition(request, o365.key);
      const second = await waitForSummaries(request, parentKey, ['Firewall', 'Jira', 'Slack', 'Harvest']);
      for (const name of ['Firewall', 'Jira', 'Slack', 'Harvest']) {
        expect([...second.values()].filter((item) => norm(item.fields.summary).includes(norm(name))), `${name} should be created exactly once`).toHaveLength(1);
      }

      const secondChildren = [...second.values()].filter((item) => ['firewall', 'jira', 'slack', 'harvest'].some((name) => norm(item.fields.summary).includes(name)));
      for (const child of secondChildren.slice(0, -1)) {
        await doneTransition(request, child.key);
        await new Promise((resolve) => setTimeout(resolve, Math.min(15000, pollMs)));
        const current = await children(request, parentKey);
        expect(current.some((item) => norm(item.fields.summary).includes('assets')), 'Assets appeared before all second-wave tasks completed').toBeFalsy();
      }
      await doneTransition(request, secondChildren.at(-1).key);

      const withAssets = await waitForSummaries(request, parentKey, ['Assets']);
      const assetsChildren = [...withAssets.values()].filter((item) => norm(item.fields.summary).includes('assets'));
      expect(assetsChildren).toHaveLength(1);

      await doneTransition(request, assetsChildren[0].key);
      await waitForParentDone(request, parentKey);

      const completedChildren = await children(request, parentKey);
      expect(completedChildren.some((item) => norm(item.fields.summary).includes('pbx')), 'PBX must not be created on the explicit no-ServiceDesk branch').toBeFalsy();

      const orchestration = completedChildren.filter((item) => (item.fields.labels || []).includes('ivanti-orchestration'));
      const duplicateSummaries = orchestration.reduce((acc, item) => {
        const key = norm(item.fields.summary);
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
      }, new Map());
      expect([...duplicateSummaries.entries()].filter(([, count]) => count > 1), 'No orchestration node may create duplicate Jira subtasks').toEqual([]);
    } finally {
      if (parentKey) {
        const response = await request.delete(`/rest/api/3/issue/${parentKey}?deleteSubtasks=true`);
        if (!response.ok() && response.status() !== 404) console.warn(`QA cleanup could not delete ${parentKey}: ${response.status()}`);
      }
    }
  });
});
