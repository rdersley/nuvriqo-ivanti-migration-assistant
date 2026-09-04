import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

export type ExecutableTask = {
  blockId: string;
  title: string;
  summary?: string;
  details?: string;
  team?: string;
  dueDays?: number;
};

export type ExecutableStage = {
  id: string;
  title: string;
  taskBlockIds: string[];
};

export type ExecutableBranch = {
  id: string;
  title: string;
  jiraFieldId?: string;
  operator?: string;
  value?: string;
  yesTaskBlockIds: string[];
  noTaskBlockIds: string[];
};

export type ExecutablePlan = {
  version: 1;
  serviceId: string;
  serviceName: string;
  projectId: string;
  issueTypeId: string;
  workflowName: string;
  workflowVersion: string;
  tasks: ExecutableTask[];
  stages: ExecutableStage[];
  branch?: ExecutableBranch;
  sourceDefects?: string[];
  installedAt: string;
};

type ExecutionState = {
  parentIssueId: string;
  parentIssueKey: string;
  projectId: string;
  issueTypeId: string;
  stageIndex: number;
  createdTasks: Record<string, string>;
  branchEvaluated?: boolean;
  branchResult?: 'yes' | 'no' | 'unknown';
  completed?: boolean;
  updatedAt: string;
};

type JiraIssue = {
  id: string;
  key: string;
  fields?: Record<string, any> & {
    project?: { id?: string; key?: string };
    issuetype?: { id?: string; name?: string; subtask?: boolean };
    parent?: { id?: string; key?: string };
    status?: { statusCategory?: { key?: string; name?: string } };
    summary?: string;
    labels?: string[];
  };
};

type JiraResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

const PLAN_PREFIX = 'ivanti-executable-plan-v1';
const STATE_PREFIX = 'ivanti-execution-state-v1';
const ORCH_LABEL = 'ivanti-orchestration';

const planKey = (projectId: string, issueTypeId: string) => `${PLAN_PREFIX}:${projectId}:${issueTypeId}`;
const stateKey = (issueId: string) => `${STATE_PREFIX}:${issueId}`;
const compact = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const normal = (value: unknown) => compact(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function adf(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: text ? [{ type: 'paragraph', content: [{ type: 'text', text }] }] : []
  };
}

async function jiraJson<T>(response: JiraResponseLike): Promise<T> {
  const text = await response.text();
  let body: any = undefined;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) throw new Error(`Jira ${response.status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body).slice(0, 500)}`);
  return body as T;
}

function findTask(plan: ExecutablePlan, patterns: RegExp[]): ExecutableTask | undefined {
  return plan.tasks.find((task) => {
    const label = normal(`${task.title} ${task.summary || ''}`);
    return patterns.some((pattern) => pattern.test(label));
  });
}

function canonicaliseNewEmployeeSetup(raw: ExecutablePlan): ExecutablePlan {
  if (!/new employee setup/i.test(raw.serviceName || raw.workflowName || '')) return raw;

  const ad = findTask(raw, [/active directory/, /\bad\b.*account/]);
  const office = findTask(raw, [/office 365/, /o365/, /microsoft 365/]);
  const network = findTask(raw, [/firewall.*vpn/, /cisco.*vpn/, /vpn.*cisco/, /firewall/]);
  const jira = findTask(raw, [/\bjira\b/]);
  const slack = findTask(raw, [/\bslack\b/]);
  const harvest = findTask(raw, [/\bharvest\b/]);
  const assets = findTask(raw, [/\bassets?\b/]);
  const pbx = findTask(raw, [/\bpbx\b/]);

  const required = [ad, office, network, jira, slack, harvest, assets, pbx];
  if (required.some((task) => !task)) return raw;

  const ids = (tasks: Array<ExecutableTask | undefined>) => tasks.filter(Boolean).map((task) => String(task!.blockId));
  const branch: ExecutableBranch = {
    ...(raw.branch || {
      id: 'servicedesk-branch',
      title: 'Check if ServiceDesk',
      operator: 'equals',
      value: 'Yes',
      yesTaskBlockIds: [],
      noTaskBlockIds: []
    }),
    title: raw.branch?.title || 'Check if ServiceDesk',
    value: raw.branch?.value || 'Yes',
    yesTaskBlockIds: ids([pbx]),
    noTaskBlockIds: []
  };

  const sourceDefects = [...new Set([
    ...(raw.sourceDefects || []),
    'Ivanti v52 contains an unnamed Quick Action whose ok exit is not connected; its behaviour is intentionally not invented by the migration engine.'
  ])];

  return {
    ...raw,
    stages: [
      { id: 'wave-1-identity', title: 'Identity and productivity', taskBlockIds: ids([ad, office]) },
      { id: 'wave-2-access-apps', title: 'Access and application provisioning', taskBlockIds: ids([network, jira, slack, harvest]) },
      { id: 'wave-3-assets', title: 'Assets provisioning', taskBlockIds: ids([assets]) }
    ],
    branch,
    sourceDefects
  };
}

export async function saveExecutablePlan(raw: ExecutablePlan): Promise<ExecutablePlan> {
  if (!raw?.projectId || !raw?.issueTypeId || !raw?.serviceName) throw new Error('Executable orchestration plan is missing project, issue type or service name.');
  const canonical = canonicaliseNewEmployeeSetup(raw);
  const taskIds = new Set((canonical.tasks || []).map((task) => String(task.blockId)));
  for (const stage of canonical.stages || []) {
    for (const id of stage.taskBlockIds || []) if (!taskIds.has(String(id))) throw new Error(`Stage ${stage.id} references unknown task block ${id}.`);
  }
  if (canonical.branch) {
    for (const id of [...canonical.branch.yesTaskBlockIds, ...canonical.branch.noTaskBlockIds]) {
      if (!taskIds.has(String(id))) throw new Error(`Branch ${canonical.branch.id} references unknown task block ${id}.`);
    }
  }
  const plan: ExecutablePlan = {
    ...canonical,
    version: 1,
    tasks: canonical.tasks || [],
    stages: canonical.stages || [],
    installedAt: new Date().toISOString()
  };
  await kvs.set(planKey(plan.projectId, plan.issueTypeId), plan);
  return plan;
}

export async function getExecutablePlan(projectId: string, issueTypeId: string): Promise<ExecutablePlan | undefined> {
  return await kvs.get(planKey(projectId, issueTypeId)) as ExecutablePlan | undefined;
}

async function projectSubtaskType(projectId: string): Promise<string> {
  const response = await api.asApp().requestJira(route`/rest/api/3/project/${projectId}`,
    { headers: { Accept: 'application/json' } });
  const project = await jiraJson<{ issueTypes?: Array<{ id?: string; name?: string; subtask?: boolean }> }>(response);
  const subtask = (project.issueTypes || []).find((type) => type.subtask) || (project.issueTypes || []).find((type) => /sub.?task/i.test(String(type.name || '')));
  if (!subtask?.id) throw new Error(`No sub-task issue type is available in Jira project ${projectId}.`);
  return String(subtask.id);
}

async function createChildTask(plan: ExecutablePlan, state: ExecutionState, task: ExecutableTask): Promise<string> {
  if (state.createdTasks[task.blockId]) return state.createdTasks[task.blockId];
  const issueTypeId = await projectSubtaskType(plan.projectId);
  const description = [task.details, task.team ? `Ivanti assignment team: ${task.team}` : '', task.dueDays ? `Ivanti due target: ${task.dueDays} day(s)` : ''].filter(Boolean).join('\n\n');
  const response = await api.asApp().requestJira(route`/rest/api/3/issue`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        project: { id: plan.projectId },
        parent: { key: state.parentIssueKey },
        issuetype: { id: issueTypeId },
        summary: task.summary || task.title,
        description: adf(description || `Migrated Ivanti fulfilment task: ${task.title}`),
        labels: [ORCH_LABEL, `ivanti-block-${task.blockId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)}`]
      }
    })
  });
  const created = await jiraJson<{ id: string; key: string }>(response);
  state.createdTasks[task.blockId] = created.key;
  state.updatedAt = new Date().toISOString();
  await kvs.set(stateKey(state.parentIssueId), state);
  return created.key;
}

async function createTaskSet(plan: ExecutablePlan, state: ExecutionState, blockIds: string[]) {
  const byId = new Map(plan.tasks.map((task) => [String(task.blockId), task]));
  for (const blockId of blockIds) {
    const task = byId.get(String(blockId));
    if (task) await createChildTask(plan, state, task);
  }
}

async function getIssue(issueKeyOrId: string): Promise<JiraIssue> {
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKeyOrId}?fields=project,issuetype,parent,status,summary,labels,*all`, {
    headers: { Accept: 'application/json' }
  });
  return jiraJson<JiraIssue>(response);
}

async function childIssue(key: string): Promise<JiraIssue | undefined> {
  try { return await getIssue(key); } catch { return undefined; }
}

async function allDone(state: ExecutionState, blockIds: string[]): Promise<boolean> {
  if (!blockIds.length) return true;
  for (const id of blockIds) {
    const key = state.createdTasks[String(id)];
    if (!key) return false;
    const issue = await childIssue(key);
    const category = compact(issue?.fields?.status?.statusCategory?.key).toLowerCase();
    if (category !== 'done') return false;
  }
  return true;
}

async function transitionParentToCompleted(parentKey: string) {
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${parentKey}/transitions`, { headers: { Accept: 'application/json' } });
  const body = await jiraJson<{ transitions?: Array<{ id?: string; name?: string; to?: { name?: string; statusCategory?: { key?: string } } }> }>(response);
  const transition = (body.transitions || []).find((item) => /^(completed|done|resolved|closed)$/i.test(compact(item.to?.name || item.name)))
    || (body.transitions || []).find((item) => compact(item.to?.statusCategory?.key).toLowerCase() === 'done');
  if (!transition?.id) throw new Error(`No transition to a Done status is available for ${parentKey}.`);
  const apply = await api.asApp().requestJira(route`/rest/api/3/issue/${parentKey}/transitions`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: String(transition.id) } })
  });
  if (!apply.ok) await jiraJson(apply);
}

function truthyChoice(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  const actual = typeof value === 'object' && value && 'value' in (value as any) ? (value as any).value : value;
  return /^(yes|true|1|required|requested)$/i.test(compact(actual));
}

function hasChoice(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (typeof value === 'object' && value && 'value' in (value as any)) return Boolean(compact((value as any).value));
  return true;
}

async function resolveBranchFieldId(plan: ExecutablePlan): Promise<string | undefined> {
  if (!plan.branch) return undefined;
  if (plan.branch.jiraFieldId) return plan.branch.jiraFieldId;

  const response = await api.asApp().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  const fields = await jiraJson<Array<{ id?: string; name?: string }>>(response);
  const candidates = [plan.branch.title, 'Is user in ServiceDesk', 'isServiceDesk', 'ServiceDesk'];
  const wanted = candidates.map(normal).filter(Boolean);
  const exact = fields.find((field) => wanted.includes(normal(field.name)));
  if (exact?.id) return String(exact.id);
  const fuzzy = fields.find((field) => {
    const name = normal(field.name);
    return name.includes('service') && name.includes('desk');
  });
  return fuzzy?.id ? String(fuzzy.id) : undefined;
}

async function reconcileParent(plan: ExecutablePlan, parent: JiraIssue) {
  const id = String(parent.id);
  let state = await kvs.get(stateKey(id)) as ExecutionState | undefined;
  if (!state) {
    state = {
      parentIssueId: id,
      parentIssueKey: parent.key,
      projectId: plan.projectId,
      issueTypeId: plan.issueTypeId,
      stageIndex: 0,
      createdTasks: {},
      updatedAt: new Date().toISOString()
    };
    await kvs.set(stateKey(id), state);
  }
  if (state.completed) return;

  if (plan.stages.length) {
    const current = plan.stages[Math.min(state.stageIndex, plan.stages.length - 1)];
    await createTaskSet(plan, state, current.taskBlockIds);
    if (!(await allDone(state, current.taskBlockIds))) return;
    if (state.stageIndex < plan.stages.length - 1) {
      state.stageIndex += 1;
      state.updatedAt = new Date().toISOString();
      await kvs.set(stateKey(id), state);
      const next = plan.stages[state.stageIndex];
      await createTaskSet(plan, state, next.taskBlockIds);
      return;
    }
  }

  if (plan.branch && !state.branchEvaluated) {
    const freshParent = await getIssue(parent.key);
    const resolvedFieldId = await resolveBranchFieldId(plan);
    if (!resolvedFieldId) {
      state.branchResult = 'unknown';
      state.updatedAt = new Date().toISOString();
      await kvs.set(stateKey(id), state);
      return;
    }

    const fieldValue = freshParent.fields?.[resolvedFieldId];
    if (!hasChoice(fieldValue)) {
      state.branchResult = 'unknown';
      state.updatedAt = new Date().toISOString();
      await kvs.set(stateKey(id), state);
      return;
    }

    const expectedYes = truthyChoice(plan.branch.value || 'Yes');
    const actualYes = truthyChoice(fieldValue);
    const isYes = expectedYes ? actualYes : compact(fieldValue).toLowerCase() === compact(plan.branch.value).toLowerCase();
    state.branchEvaluated = true;
    state.branchResult = isYes ? 'yes' : 'no';
    state.updatedAt = new Date().toISOString();
    await kvs.set(stateKey(id), state);
    const branchTasks = isYes ? plan.branch.yesTaskBlockIds : plan.branch.noTaskBlockIds;
    if (branchTasks.length) {
      await createTaskSet(plan, state, branchTasks);
      return;
    }
  }

  if (plan.branch) {
    if (!state.branchEvaluated || state.branchResult === 'unknown') return;
    const branchIds = state.branchResult === 'yes' ? plan.branch.yesTaskBlockIds : plan.branch.noTaskBlockIds;
    if (!(await allDone(state, branchIds))) return;
  }

  await transitionParentToCompleted(parent.key);
  state.completed = true;
  state.updatedAt = new Date().toISOString();
  await kvs.set(stateKey(id), state);
}

export async function getExecutionState(issueId: string) {
  return await kvs.get(stateKey(issueId)) as ExecutionState | undefined;
}

export async function handleIssueEvent(event: any) {
  const eventIssue = event?.issue as JiraIssue | undefined;
  if (!eventIssue?.id) return;
  const issue = await getIssue(eventIssue.key || eventIssue.id);
  const projectId = String(issue.fields?.project?.id || '');
  const issueTypeId = String(issue.fields?.issuetype?.id || '');

  const directPlan = projectId && issueTypeId ? await getExecutablePlan(projectId, issueTypeId) : undefined;
  if (directPlan) {
    await reconcileParent(directPlan, issue);
    return;
  }

  const parentKey = issue.fields?.parent?.key;
  if (!parentKey) return;
  const parent = await getIssue(parentKey);
  const parentProjectId = String(parent.fields?.project?.id || '');
  const parentIssueTypeId = String(parent.fields?.issuetype?.id || '');
  if (!parentProjectId || !parentIssueTypeId) return;
  const parentPlan = await getExecutablePlan(parentProjectId, parentIssueTypeId);
  if (parentPlan) await reconcileParent(parentPlan, parent);
}
