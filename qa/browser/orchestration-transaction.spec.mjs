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

test.describe('Ivanti orchestration - live transactional Jira QA', () => {
  test('runs New Employee Setup through both gates to Assets without duplicate subtasks', async ({ request }) => {
    test.setTimeout(12 * 60 * 1000);
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

      const initial = await waitForSummaries(request, parentKey, ['Active Directory', 'Office 365']);
      const initialChildren = [...initial.values()];
      expect(initialChildren.filter((item) => /active directory/i.test(item.fields.summary))).toHaveLength(1);
      expect(initialChildren.filter((item) => /office 365/i.test(item.fields.summary))).toHaveLength(1);

      const ad = initialChildren.find((item) => /active directory/i.test(item.fields.summary));
      const o365 = initialChildren.find((item) => /office 365/i.test(item.fields.summary));
      await doneTransition(request, ad.key);

      // One completed first-wave task must not open the second gate.
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
      expect([...withAssets.values()].filter((item) => norm(item.fields.summary).includes('assets'))).toHaveLength(1);

      const all = [...withAssets.values()];
      const orchestration = all.filter((item) => (item.fields.labels || []).includes('ivanti-orchestration'));
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
