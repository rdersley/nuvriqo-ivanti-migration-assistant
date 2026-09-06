import { test, expect } from '@playwright/test';

const projectKey = process.env.QA_PROJECT_KEY || 'DEMO';
const serviceName = process.env.QA_SERVICE_NAME || 'New Employee Setup';
const pollMs = Number(process.env.QA_ORCHESTRATION_POLL_MS || 10000);
const waitMs = Number(process.env.QA_ORCHESTRATION_WAIT_MS || 210000);

function norm(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

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

async function waitFor(description, predicate, timeout = waitMs) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function doneTransition(request, key) {
  const data = await apiJson(request, 'GET', `/rest/api/3/issue/${key}/transitions?expand=transitions.fields`, undefined);
  const transitions = data?.transitions || [];
  const chosen = transitions.find((t) => norm(t?.to?.statusCategory?.key) === 'done')
    || transitions.find((t) => /done|complete|resolve|close/i.test(`${t?.name || ''} ${t?.to?.name || ''}`));
  if (!chosen?.id) throw new Error(`No Done-category transition available for ${key}`);
  await apiJson(request, 'POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: String(chosen.id) } });
}

async function waitForSummaries(request, parentKey, expected) {
  return waitFor(expected.join(', '), async () => {
    const list = await children(request, parentKey);
    const found = expected.map((name) => list.find((item) => norm(item?.fields?.summary).includes(norm(name))));
    return found.every(Boolean) ? list : null;
  });
}

async function waitForParentDone(request, parentKey) {
  return waitFor(`${parentKey} Done`, async () => {
    const parent = await issue(request, parentKey);
    return norm(parent?.fields?.status?.statusCategory?.key) === 'done' ? parent : null;
  });
}

function assertNoDuplicates(list) {
  const orchestration = list.filter((item) => (item.fields.labels || []).includes('ivanti-orchestration'));
  const counts = new Map();
  for (const item of orchestration) {
    const key = norm(item.fields.summary);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  expect([...counts.entries()].filter(([, count]) => count > 1), 'No orchestration node may create duplicate Jira subtasks').toEqual([]);
}

test.describe('Ivanti orchestration - live ServiceDesk Yes branch', () => {
  test.describe.configure({ retries: 0 });

  test('creates PBX exactly once and completes parent only after PBX completes', async ({ request }) => {
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
      await setServiceDeskDecision(request, parentKey, 'Yes');

      const initial = await waitForSummaries(request, parentKey, ['Active Directory', 'Office 365']);
      await doneTransition(request, initial.find((item) => /active directory/i.test(item.fields.summary)).key);
      await doneTransition(request, initial.find((item) => /office 365/i.test(item.fields.summary)).key);

      const second = await waitForSummaries(request, parentKey, ['Firewall', 'Jira', 'Slack', 'Harvest']);
      const secondChildren = second.filter((item) => ['firewall', 'jira', 'slack', 'harvest'].some((name) => norm(item.fields.summary).includes(name)));
      expect(secondChildren).toHaveLength(4);
      for (const child of secondChildren) await doneTransition(request, child.key);

      const withAssets = await waitForSummaries(request, parentKey, ['Assets']);
      const assets = withAssets.filter((item) => norm(item.fields.summary).includes('assets'));
      expect(assets).toHaveLength(1);
      await doneTransition(request, assets[0].key);

      const withPbx = await waitForSummaries(request, parentKey, ['PBX']);
      const pbx = withPbx.filter((item) => norm(item.fields.summary).includes('pbx'));
      expect(pbx, 'PBX should be created exactly once on ServiceDesk Yes').toHaveLength(1);

      const beforePbxDone = await issue(request, parentKey);
      expect(norm(beforePbxDone?.fields?.status?.statusCategory?.key), 'Parent must remain open until PBX completes').not.toBe('done');

      await doneTransition(request, pbx[0].key);
      await waitForParentDone(request, parentKey);

      const completed = await children(request, parentKey);
      assertNoDuplicates(completed);
    } finally {
      if (parentKey) {
        const response = await request.delete(`/rest/api/3/issue/${parentKey}?deleteSubtasks=true`);
        if (!response.ok() && response.status() !== 404) console.warn(`QA cleanup could not delete ${parentKey}: ${response.status()}`);
      }
    }
  });
});
