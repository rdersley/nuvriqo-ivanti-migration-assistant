import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { saveExecutableGraph, type ExecutableGraphPlan } from './orchestrationGraphEngine';

const PROJECT_ID = '12789';
const PROJECT_KEY = 'IT';
const SERVICE_DESK_ID = '2183';
const RUN_STATE_KEY = 'rim-production-migration-runner-v1';

const REQUEST_TYPES: Record<string, string> = {
  'AWS Account management': '2424',
  'Bitbucket Cloud Support': '2425',
  'Domain Password Reset': '2426',
  'Employee Move': '2427',
  'Leaver': '2428',
  'New Application Access Request': '2429',
  'New IT Software Request': '2430',
  'New Service Request': '2431',
  'New Vector System Provisioning': '2432',
  'Production Vector System Decommissioning': '2433',
  'Suspend Temporary Access': '2434',
  'Test Vector System Decommissioning': '2435',
  'UAT Vector System Decommissioning': '2436',
  'cBase Leaver': '2437'
};

type SourceField = {
  sourceId?: string;
  sourceName?: string;
  name: string;
  description?: string;
  jiraType?: string;
  required?: boolean;
  sequence?: number;
  visibilityExpression?: string;
  options?: string[];
};
type SourceSection = { name: string; sequence?: number };
type SourceService = { name: string; fields?: SourceField[]; sections?: SourceSection[] };
type MappedField = {
  qid: string; sequence: number; sourceName: string; name: string;
  jiraFieldId: string; jiraType: string; visibilityExpression: string;
};
type CompletionService = {
  name: string; requestTypeId: string; issueTypeId: string; approval: boolean;
  tasks?: string[]; routingTeam?: string; orchestrationHold?: string;
};
type CompletionPlan = {
  target: { projectKey: string; projectId: string; serviceDeskId: string; workflowSchemeId: string };
  workflows: { standard: string; approval: string };
  services: CompletionService[];
};
type Payload = { runId?: string; projectKey?: string; projectId?: string; services?: SourceService[]; completionPlan?: CompletionPlan };
type JiraField = { id: string; name: string; schema?: { custom?: string } };

type WebtriggerRequest = {
  method?: string;
  body?: string;
  headers?: Record<string, string | string[] | undefined>;
};

const jsonResponse = (statusCode: number, value: unknown) => ({
  statusCode,
  headers: { 'Content-Type': ['application/json'] },
  body: JSON.stringify(value)
});

function normalise(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

type ParsedVisibilityCheck = { sourceName: string; value: string };

function parseVisibilityExpression(expression: unknown): ParsedVisibilityCheck[][] {
  let text = String(expression ?? '').replace(/\r?\n/g, ' ').trim();
  if (!text) return [];
  text = text.replace(/^\$\(\s*/, '').replace(/\)\s*$/, '').trim();
  const wrapped = text.match(/^if\s+(.+?)\s+then\s+true\s+else\s+false$/i);
  if (wrapped) text = wrapped[1].trim();
  const groups: ParsedVisibilityCheck[][] = [];
  for (const orPart of text.split(/\s*\|\|\s*/)) {
    const checks: ParsedVisibilityCheck[] = [];
    for (const andPart of orPart.split(/\s*&&\s*/)) {
      const match = andPart.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*==\s*(?:"([^"]*)"|'([^']*)'|(true|false))$/i);
      if (!match) return [];
      const raw = String(match[2] ?? match[3] ?? match[4] ?? '').trim();
      checks.push({ sourceName: String(match[1]), value: /^(true|false)$/i.test(raw) ? (raw.toLowerCase() === 'true' ? 'Yes' : 'No') : raw });
    }
    if (checks.length) groups.push(checks);
  }
  return groups;
}

async function parseJira<T>(response: any): Promise<T> {
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const error = new Error(`Jira HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    (error as any).status = response.status;
    (error as any).body = body;
    throw error;
  }
  return body as T;
}

function jiraKind(field: JiraField): string | undefined {
  if (field.id === 'summary') return 'text';
  if (field.id === 'description') return 'paragraph';
  const custom = String(field.schema?.custom ?? '');
  if (custom.includes('textarea')) return 'paragraph';
  if (custom.includes('textfield')) return 'text';
  if (custom.includes('datepicker')) return 'date';
  if (custom.includes('userpicker')) return 'user';
  if (custom.endsWith(':select')) return 'select';
  if (custom.includes('float')) return 'number';
  return undefined;
}

async function ensureLookupFallbackFields(existing: JiraField[], services: SourceService[]): Promise<JiraField[]> {
  const merged = [...existing];
  const lookupNames = [...new Set(services.flatMap((service) =>
    (service.fields ?? [])
      .filter((field) => String(field.jiraType ?? '').toLowerCase() === 'lookup-select')
      .map((field) => String(field.name ?? '').trim())
      .filter(Boolean)
  ))];
  for (const sourceName of lookupNames) {
    const candidates = [sourceName, `${sourceName} - Ivanti`];
    if (merged.some((field) => candidates.some((candidate) => normalise(field.name) === normalise(candidate)) && jiraKind(field) === 'text')) continue;
    const response = await api.asApp().requestJira(route`/rest/api/3/field`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${sourceName} - Ivanti`,
        description: `Migrated from an Ivanti dynamic lookup. The source API does not expose its values, so this field preserves the question as free text without inventing options.`,
        type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
        searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'
      })
    });
    const created = await parseJira<JiraField>(response);
    if (!created?.id) throw new Error(`Jira did not return an ID for lookup fallback field ${sourceName}.`);
    merged.push(created);
  }
  return merged;
}

function compatible(field: JiraField, requestedType: string): boolean {
  const actual = jiraKind(field);
  if ((field.id === 'summary' || field.id === 'description') && ['text', 'paragraph'].includes(requestedType)) return true;
  if (requestedType === 'checkbox') return actual === 'select';
  if (requestedType === 'lookup-select') return actual === 'text';
  return actual === requestedType;
}

async function getAllFields(): Promise<JiraField[]> {
  const visibleResponse = await api.asApp().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  const visible = await parseJira<JiraField[]>(visibleResponse);
  const merged = new Map<string, JiraField>();
  visible.forEach((field) => field?.id && merged.set(String(field.id), field));
  let startAt = 0;
  for (let page = 0; page < 100; page += 1) {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=100`,
      { headers: { Accept: 'application/json' } }
    );
    const body = await parseJira<{ values?: JiraField[]; total?: number; startAt?: number; maxResults?: number; isLast?: boolean }>(response);
    const values = body.values ?? [];
    values.forEach((field) => field?.id && merged.set(String(field.id), field));
    if (!values.length || body.isLast === true) break;
    startAt = Number(body.startAt ?? startAt) + Number(body.maxResults ?? 100);
    if (Number.isFinite(body.total) && startAt >= Number(body.total)) break;
  }
  return [...merged.values()];
}

function questionType(jiraType?: string): 'ts' | 'tl' | 'da' | 'cd' | 'us' | 'no' {
  switch (String(jiraType ?? '').toLowerCase()) {
    case 'paragraph': return 'tl';
    case 'date': return 'da';
    case 'select':
    case 'checkbox': return 'cd';
    case 'user': return 'us';
    case 'number': return 'no';
    default: return 'ts';
  }
}

function questionExtension(questionId: string) {
  return {
    type: 'extension',
    attrs: {
      extensionKey: 'question',
      extensionType: 'com.thinktilt.proforma',
      layout: 'default',
      localId: `migration-${questionId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      parameters: { id: Number(questionId) }
    }
  };
}

function headingNode(name: string) {
  return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: name }] };
}

function collectQuestionIds(layout: unknown[]): string[] {
  const ids: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (record.type === 'extension' && attrs?.extensionKey === 'question') {
      const parameters = attrs.parameters as Record<string, unknown> | undefined;
      if (parameters?.id !== undefined) ids.push(String(parameters.id));
    }
    if (Array.isArray(record.content)) record.content.forEach(visit);
  };
  layout.forEach(visit);
  return ids;
}

function findPersistedQuestion(questions: Record<string, any>, jiraFieldId: string) {
  const entry = Object.entries(questions).find(([, question]) => String(question?.jiraField ?? '') === jiraFieldId);
  if (!entry) return undefined;
  const [mapKey, question] = entry;
  return { id: String(question?.id ?? mapKey), mapKey: String(mapKey), question };
}

function findChoiceToken(node: unknown, wantedValue: string, seen = new Set<unknown>()): string | undefined {
  if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const value of node) {
      const token = findChoiceToken(value, wantedValue, seen);
      if (token) return token;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const labels = [record.label, record.name, record.text, record.displayName, record.value]
    .filter((value) => value != null).map(String);
  if (labels.some((value) => normalise(value) === normalise(wantedValue))) {
    for (const key of ['id', 'choiceId', 'key', 'optionId', 'value']) {
      const token = record[key];
      if (token != null && String(token).trim()) return String(token);
    }
  }
  for (const value of Object.values(record)) {
    const token = findChoiceToken(value, wantedValue, seen);
    if (token) return token;
  }
  return undefined;
}

async function jiraOptionId(jiraFieldId: string, wantedValue: string): Promise<string | undefined> {
  const contexts = await parseJira<{ values?: Array<{ id?: string }> }>(await api.asApp().requestJira(
    route`/rest/api/3/field/${jiraFieldId}/context?startAt=0&maxResults=100`, { headers: { Accept: 'application/json' } }
  ));
  for (const context of contexts.values ?? []) {
    if (!context.id) continue;
    const options = await parseJira<{ values?: Array<{ id?: string; value?: string }> }>(await api.asApp().requestJira(
      route`/rest/api/3/field/${jiraFieldId}/context/${String(context.id)}/option?startAt=0&maxResults=1000`,
      { headers: { Accept: 'application/json' } }
    ));
    const match = (options.values ?? []).find((item) => normalise(item.value) === normalise(wantedValue));
    if (match?.id) return String(match.id);
  }
  return undefined;
}

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string {
  if (!headers) return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function validateCompletionPlan(plan: CompletionPlan | undefined): CompletionPlan {
  if (!plan || plan.target.projectKey !== PROJECT_KEY || plan.target.projectId !== PROJECT_ID || plan.target.serviceDeskId !== SERVICE_DESK_ID) {
    throw new Error('Completion plan target guard failed.');
  }
  if (plan.services.length !== 14) throw new Error(`Completion plan must contain exactly 14 services; received ${plan.services.length}.`);
  const approved = Object.entries(REQUEST_TYPES);
  for (const [name, requestTypeId] of approved) {
    const service = plan.services.find((item) => item.name === name && item.requestTypeId === requestTypeId);
    if (!service?.issueTypeId || !/^125(?:2[5-9]|3[0-8])$/.test(service.issueTypeId)) {
      throw new Error(`Completion plan identity guard failed for ${name}.`);
    }
  }
  if (plan.services.filter((item) => item.approval).length !== 7) throw new Error('Exactly seven v11-backed approval services are required.');
  return plan;
}

function buildExecutablePlan(service: CompletionService): ExecutableGraphPlan | undefined {
  if (!service.tasks?.length) return undefined;
  const taskNodes = service.tasks.map((title, index) => ({
    id: `task-${index + 1}`,
    sourceType: 'v11-recurring-task',
    kind: 'task' as const,
    title,
    summary: title,
    details: `Source-backed recurring Ivanti fulfilment task for ${service.name}.`,
    team: service.routingTeam,
    outcomes: ['completed']
  }));
  const nodes = [
    { id: 'start', sourceType: 'v11-history', kind: 'start' as const, title: 'Start fulfilment', outcomes: ['ok'] },
    ...taskNodes,
    { id: 'join', sourceType: 'v11-history', kind: 'gate' as const, title: 'All source-backed tasks complete', outcomes: ['ok'] },
    { id: 'stop', sourceType: 'v11-history', kind: 'stop' as const, title: 'Complete request', outcomes: [] }
  ];
  const transitions = [
    ...taskNodes.map((node) => ({ sourceId: 'start', sourceTitle: 'Start fulfilment', outcome: 'ok', targetId: node.id, targetTitle: node.title })),
    ...taskNodes.map((node) => ({ sourceId: node.id, sourceTitle: node.title, outcome: 'completed', targetId: 'join', targetTitle: 'All source-backed tasks complete' })),
    { sourceId: 'join', sourceTitle: 'All source-backed tasks complete', outcome: 'ok', targetId: 'stop', targetTitle: 'Complete request' }
  ];
  return {
    version: 2,
    serviceId: service.requestTypeId,
    serviceName: service.name,
    projectId: PROJECT_ID,
    issueTypeId: service.issueTypeId,
    workflowName: `${service.name} — v11 recurring fulfilment`,
    workflowVersion: 'v11-20260915',
    entryNodeIds: ['start'], nodes, transitions
  };
}

async function installSourceBackedOrchestration(plan: CompletionPlan) {
  const results: Array<{ service: string; status: string; tasks: number; hold?: string }> = [];
  for (const service of plan.services) {
    const graph = buildExecutablePlan(service);
    if (!graph) {
      results.push({ service: service.name, status: service.orchestrationHold ? 'source-hold' : 'not-evidenced', tasks: 0, hold: service.orchestrationHold });
      continue;
    }
    await saveExecutableGraph(graph);
    results.push({ service: service.name, status: 'installed', tasks: service.tasks?.length ?? 0, hold: service.orchestrationHold });
  }
  return results;
}

async function applyItWorkflowMappings(plan: CompletionPlan) {
  const targetSchemeId = String(plan.target.workflowSchemeId);
  const projectSchemes = await parseJira<{ values?: Array<{ projectIds?: string[]; workflowScheme?: any }> }>(
    await api.asApp().requestJira(route`/rest/api/3/workflowscheme/project?projectId=${PROJECT_ID}`, { headers: { Accept: 'application/json' } })
  );
  const association = (projectSchemes.values ?? []).find((item) => (item.projectIds ?? []).map(String).includes(PROJECT_ID));
  const scheme = association?.workflowScheme;
  if (!scheme || String(scheme.id) !== targetSchemeId || (association?.projectIds ?? []).map(String).some((id) => id !== PROJECT_ID)) {
    throw new Error('IT workflow scheme is missing, changed, or shared with another project; refusing to update it.');
  }
  const desired = { ...(scheme.issueTypeMappings ?? {}) } as Record<string, string>;
  for (const service of plan.services) desired[service.issueTypeId] = service.approval ? plan.workflows.approval : plan.workflows.standard;
  if (plan.services.every((service) => scheme.issueTypeMappings?.[service.issueTypeId] === desired[service.issueTypeId])) {
    return { status: 'already-mapped', schemeId: targetSchemeId, mapped: 14 };
  }

  let draftResponse = await api.asApp().requestJira(route`/rest/api/3/workflowscheme/${targetSchemeId}/draft`, { headers: { Accept: 'application/json' } });
  if (draftResponse.status === 404) {
    const createDraft = await api.asApp().requestJira(route`/rest/api/3/workflowscheme/${targetSchemeId}/createdraft`, {
      method: 'POST', headers: { Accept: 'application/json' }
    });
    await parseJira(createDraft);
    draftResponse = await api.asApp().requestJira(route`/rest/api/3/workflowscheme/${targetSchemeId}/draft`, { headers: { Accept: 'application/json' } });
  }
  const draft = await parseJira<any>(draftResponse);
  const updateDraft = await api.asApp().requestJira(route`/rest/api/3/workflowscheme/${targetSchemeId}/draft`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: draft.name ?? scheme.name,
      description: draft.description ?? scheme.description ?? '',
      defaultWorkflow: draft.defaultWorkflow ?? scheme.defaultWorkflow,
      issueTypeMappings: desired,
      updateDraftIfNeeded: true
    })
  });
  await parseJira(updateDraft);
  const draftReadback = await parseJira<any>(await api.asApp().requestJira(
    route`/rest/api/3/workflowscheme/${targetSchemeId}/draft`, { headers: { Accept: 'application/json' } }
  ));
  for (const service of plan.services) {
    if (draftReadback.issueTypeMappings?.[service.issueTypeId] !== desired[service.issueTypeId]) throw new Error(`Draft workflow readback failed for ${service.name}.`);
  }
  const publish = await api.asApp().requestJira(route`/rest/api/3/workflowscheme/${targetSchemeId}/draft/publish`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    // The migrated issue types currently inherit Jira's legacy Open/Reopened
    // states. Both existing IT fulfilment workflows use Waiting for Support as
    // the active intake state, so preserve that operational meaning explicitly.
    body: JSON.stringify({
      statusMappings: plan.services.flatMap((service) => [
        { issueTypeId: service.issueTypeId, statusId: '1', newStatusId: '10121' },
        { issueTypeId: service.issueTypeId, statusId: '4', newStatusId: '10121' }
      ])
    })
  });
  await parseJira(publish);
  // The project-association endpoint returns an abridged workflow scheme and can
  // lag immediately after publication. Read the authoritative scheme resource,
  // retrying briefly while Jira finishes activating the published draft.
  let finalScheme: any;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    finalScheme = await parseJira<any>(await api.asApp().requestJira(
      route`/rest/api/3/workflowscheme/${targetSchemeId}`, { headers: { Accept: 'application/json' } }
    ));
    if (plan.services.every((service) => finalScheme?.issueTypeMappings?.[service.issueTypeId] === desired[service.issueTypeId])) break;
    if (attempt < 11) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  for (const service of plan.services) {
    if (finalScheme?.issueTypeMappings?.[service.issueTypeId] !== desired[service.issueTypeId]) throw new Error(`Published workflow readback failed for ${service.name}.`);
  }
  return { status: 'published', schemeId: targetSchemeId, mapped: 14 };
}

export async function handler(request: WebtriggerRequest) {
  try {
    if (String(request.method ?? '').toUpperCase() !== 'POST') return jsonResponse(405, { ok: false, error: 'POST required.' });
    const configuredToken = String(process.env.MIGRATION_RUNNER_TOKEN ?? '').trim();
    if (!configuredToken) return jsonResponse(503, { ok: false, error: 'Migration runner token is not configured.' });
    const auth = headerValue(request.headers, 'authorization');
    if (auth !== `Bearer ${configuredToken}`) return jsonResponse(401, { ok: false, error: 'Unauthorized.' });

    const payload = JSON.parse(String(request.body ?? '{}')) as Payload;
    if (payload.projectKey !== PROJECT_KEY || payload.projectId !== PROJECT_ID) {
      return jsonResponse(400, { ok: false, error: 'Hard target guard failed.', expected: { projectKey: PROJECT_KEY, projectId: PROJECT_ID } });
    }
    if (!payload.runId || !Array.isArray(payload.services) || payload.services.length !== 14) {
      return jsonResponse(400, { ok: false, error: 'A runId and exactly 14 services are required.' });
    }

    const projectResponse = await api.asApp().requestJira(route`/rest/api/3/project/${PROJECT_KEY}`, { headers: { Accept: 'application/json' } });
    const project = await parseJira<{ id?: string; key?: string; name?: string }>(projectResponse);
    if (String(project.id ?? '') !== PROJECT_ID || String(project.key ?? '') !== PROJECT_KEY) {
      return jsonResponse(409, { ok: false, error: 'Live Jira project guard failed.', project });
    }

    const requestTypesResponse = await api.asApp().requestJira(
      route`/rest/servicedeskapi/servicedesk/${SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true`,
      { headers: { Accept: 'application/json' } }
    );
    const requestTypes = await parseJira<{ values?: Array<{ id?: string; name?: string; issueTypeId?: string }> }>(requestTypesResponse);
    for (const [name, requestTypeId] of Object.entries(REQUEST_TYPES)) {
      if (!(requestTypes.values ?? []).some((item) => String(item.id ?? '') === requestTypeId && String(item.name ?? '') === name)) {
        return jsonResponse(409, { ok: false, error: `Request type guard failed for ${name} (${requestTypeId}).` });
      }
    }

    const prior = await kvs.get(RUN_STATE_KEY) as { completedRunId?: string; completedAt?: string } | undefined;
    if (prior?.completedRunId === payload.runId) return jsonResponse(200, { ok: true, status: 'already-completed', ...prior });

    let jiraFields = await getAllFields();
    jiraFields = await ensureLookupFallbackFields(jiraFields, payload.services);
    const byName = new Map<string, JiraField[]>();
    for (const field of jiraFields) {
      const key = normalise(field.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(field);
    }

    const resolveField = (serviceName: string, source: SourceField): JiraField | undefined => {
      const requestedType = String(source.jiraType ?? 'text');
      let candidates: string[];
      if (source.name === 'Name') {
        candidates = serviceName === 'cBase Leaver' ? ['Name - cBase Leaver'] : ['Name - Ivanti Person', 'Name'];
      } else {
        candidates = [source.name, `${source.name} - Ivanti`];
      }
      for (const candidate of candidates) {
        const match = (byName.get(normalise(candidate)) ?? []).find((field) => compatible(field, requestedType));
        if (match) return match;
      }
      return undefined;
    };

    const indexResponse = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`, { headers: { Accept: 'application/json' } });
    const formIndex = await parseJira<Array<{ id?: string | number; name?: string; portalRequestTypeIds?: number[] }>>(indexResponse);
    const results: unknown[] = [];

    for (const service of payload.services) {
      const serviceName = String(service.name ?? '').trim();
      const requestTypeId = REQUEST_TYPES[serviceName];
      if (!requestTypeId) {
        results.push({ service: serviceName, status: 'failed', error: 'Service is not in the approved request-type map.' });
        continue;
      }
      const formName = `${serviceName} - Ivanti Migration Form`;
      const fields = [...(service.fields ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
      const sections = [...(service.sections ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
      const questions: Record<string, unknown> = {};
      const mapped: MappedField[] = [];
      const unresolved: Array<{ name: string; jiraType?: string; reason: string }> = [];
      let qNumber = 1;

      for (const field of fields) {
        const jiraField = resolveField(serviceName, field);
        if (!jiraField) {
          unresolved.push({ name: field.name, jiraType: field.jiraType, reason: field.jiraType === 'lookup-select' ? 'lookup-deferred' : 'no-compatible-jira-field' });
          continue;
        }
        const qid = String(qNumber++);
        questions[qid] = {
          label: field.name,
          description: field.description ?? '',
          type: questionType(field.jiraType),
          jiraField: String(jiraField.id),
          questionKey: `ivanti-${qid}`,
          validation: { rq: Boolean(field.required) }
        };
        mapped.push({
          qid,
          sequence: Number(field.sequence ?? 0),
          sourceName: String(field.sourceName ?? ''),
          name: field.name,
          jiraFieldId: String(jiraField.id),
          jiraType: String(field.jiraType ?? 'text'),
          visibilityExpression: String(field.visibilityExpression ?? '').trim()
        });
      }

      const buckets: Array<{ name: string; sequence: number; qids: string[] }> = [];
      if (sections.length) {
        sections.forEach((section) => buckets.push({ name: section.name || 'Section', sequence: Number(section.sequence ?? 0), qids: [] }));
        const pre: string[] = [];
        const unconditionalMapped: MappedField[] = mapped.filter((entry) => !entry.visibilityExpression);
        for (const item of unconditionalMapped) {
          const eligible = buckets.filter((bucket) => bucket.sequence <= item.sequence);
          if (eligible.length) eligible.sort((a, b) => b.sequence - a.sequence)[0].qids.push(item.qid);
          else pre.push(item.qid);
        }
        if (pre.length) buckets.unshift({ name: 'Request details', sequence: -1, qids: pre });
      } else {
        buckets.push({ name: 'Request details', sequence: 0, qids: mapped.filter((entry) => !entry.visibilityExpression).map((item) => item.qid) });
      }

      // Jira Forms conditions show/hide sections, so each conditional source
      // question is isolated in its own section instead of hiding unrelated fields.
      const conditionallyMapped: MappedField[] = mapped.filter((entry) => Boolean(entry.visibilityExpression));
      for (const item of conditionallyMapped) {
        buckets.push({ name: `${item.name} — conditional`, sequence: item.sequence, qids: [item.qid] });
      }

      const layout: unknown[] = [];
      const formSections: Record<string, unknown> = {};
      buckets.forEach((bucket, index) => {
        layout.push({ version: 1, type: 'doc', content: [headingNode(bucket.name), ...bucket.qids.map(questionExtension)] });
        if (index > 0) formSections[String(index)] = { name: bucket.name, sectionType: 'p' };
      });
      const settings = { language: 'en', name: formName, primaryLocale: 'en-US', submit: { lock: true, pdf: true } };
      const design = { conditions: {}, layout, questions, sections: formSections, settings };
      if (!Object.keys(questions).length) {
        results.push({ service: serviceName, status: 'failed', error: 'No resolvable questions.', unresolved });
        continue;
      }

      let formId = String(formIndex.find((item) => normalise(item.name) === normalise(formName))?.id ?? '');
      let baseStatus = 'reused';
      if (!formId) {
        const createResponse = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ design: { conditions: {}, layout: [], questions: {}, sections: {}, settings } })
        });
        const created = await parseJira<{ id?: string | number; formTemplate?: { id?: string | number } }>(createResponse);
        formId = String(created.formTemplate?.id ?? created.id ?? '');
        baseStatus = 'created';
        if (!formId) throw new Error(`Atlassian did not return a form ID for ${serviceName}.`);
      }

      const populateResponse = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ design })
      });
      await parseJira(populateResponse);

      const readResponse = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, { headers: { Accept: 'application/json' } });
      const stored = await parseJira<{ design?: {
        questions?: Record<string, any>; layout?: unknown[]; sections?: Record<string, any>; conditions?: Record<string, any>
      } }>(readResponse);
      const expectedIds = Object.keys(questions);
      const storedIds = Object.keys(stored.design?.questions ?? {});
      const layoutIds = collectQuestionIds(stored.design?.layout ?? []);
      const missingQuestionDefs = expectedIds.filter((id) => !storedIds.includes(id));
      const missingLayout = expectedIds.filter((id) => !layoutIds.includes(id));
      if (missingQuestionDefs.length || missingLayout.length) {
        results.push({ service: serviceName, status: 'failed', formId, stage: 'readback', missingQuestionDefs, missingLayout, unresolved });
        continue;
      }

      let activeDesign: Record<string, unknown> = stored.design ?? design;
      const conditionalItems = mapped.filter((item) => item.visibilityExpression);
      const advancedConditions: Record<string, any> = {};
      const conditionErrors: string[] = [];
      const storedQuestions = stored.design?.questions ?? {};
      const storedSections = stored.design?.sections ?? {};

      for (const [conditionIndex, target] of conditionalItems.entries()) {
        const parsedGroups = parseVisibilityExpression(target.visibilityExpression);
        if (!parsedGroups.length) {
          conditionErrors.push(`${target.name}: unsupported source expression ${target.visibilityExpression}`);
          continue;
        }
        const targetSectionName = `${target.name} — conditional`;
        const targetSection = Object.entries(storedSections).find(([, section]) => normalise(section?.name) === normalise(targetSectionName));
        if (!targetSection) {
          conditionErrors.push(`${target.name}: persisted conditional section was not found`);
          continue;
        }

        const compatibilityMap: Record<string, string[]> = {};
        const groups: Array<{ operator: 'AND'; checks: Array<{ fieldId: string; type: 'SOME_OF'; constraint: string[] }> }> = [];
        let groupFailed = false;
        for (const sourceGroup of parsedGroups) {
          const checks: Array<{ fieldId: string; type: 'SOME_OF'; constraint: string[] }> = [];
          for (const sourceCheck of sourceGroup) {
            const controller = mapped.find((item) => normalise(item.sourceName) === normalise(sourceCheck.sourceName));
            if (!controller) {
              conditionErrors.push(`${target.name}: controller ${sourceCheck.sourceName} is absent from the ROX form`);
              groupFailed = true;
              break;
            }
            if (!['select', 'checkbox'].includes(controller.jiraType.toLowerCase())) {
              conditionErrors.push(`${target.name}: controller ${controller.name} is not source-backed as a choice field`);
              groupFailed = true;
              break;
            }
            const persisted = findPersistedQuestion(storedQuestions, controller.jiraFieldId);
            if (!persisted || !String(persisted.question?.label ?? '').trim()) {
              conditionErrors.push(`${target.name}: persisted controller ${controller.name} was not found or has no label`);
              groupFailed = true;
              break;
            }
            const token = findChoiceToken(persisted.question, sourceCheck.value)
              ?? await jiraOptionId(controller.jiraFieldId, sourceCheck.value);
            if (!token) {
              conditionErrors.push(`${target.name}: value '${sourceCheck.value}' was not found for ${controller.name}`);
              groupFailed = true;
              break;
            }
            compatibilityMap[persisted.id] = [...new Set([...(compatibilityMap[persisted.id] ?? []), token])];
            checks.push({ fieldId: persisted.id, type: 'SOME_OF', constraint: [token] });
          }
          if (groupFailed) break;
          groups.push({ operator: 'AND', checks });
        }
        if (groupFailed) continue;
        const conditionId = String(conditionIndex + 1);
        advancedConditions[conditionId] = {
          i: { co: { cIds: compatibilityMap }, operator: 'OR', groups },
          o: { sIds: [String(targetSection[0])], t: 'sh' }
        };
      }

      if (conditionErrors.length || Object.keys(advancedConditions).length !== conditionalItems.length) {
        results.push({ service: serviceName, status: 'failed', formId, stage: 'conditions-build', conditionErrors, unresolved });
        continue;
      }

      if (conditionalItems.length) {
        const conditionedSections: Record<string, any> = {};
        for (const [sectionId, rawSection] of Object.entries(storedSections)) {
          const section = { ...(rawSection as Record<string, unknown>) } as any;
          section.conditions = Object.entries(advancedConditions)
            .filter(([, condition]) => (condition.o?.sIds ?? []).map(String).includes(String(sectionId)))
            .map(([conditionId]) => conditionId);
          conditionedSections[sectionId] = section;
        }
        activeDesign = { ...(stored.design ?? design), sections: conditionedSections, conditions: advancedConditions };
        const saveConditions = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, {
          method: 'PUT',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
          body: JSON.stringify({ design: activeDesign })
        });
        await parseJira(saveConditions);
        const verifyConditions = await parseJira<{ design?: { questions?: Record<string, any>; sections?: Record<string, any>; conditions?: Record<string, any> } }>(
          await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, { headers: { Accept: 'application/json' } })
        );
        const persistedConditions = verifyConditions.design?.conditions ?? {};
        const persistedSections = verifyConditions.design?.sections ?? {};
        const broken: string[] = [];
        for (const conditionId of Object.keys(advancedConditions)) {
          const condition = persistedConditions[conditionId];
          const controllerIds = Object.keys(condition?.i?.co?.cIds ?? {});
          const checks = (condition?.i?.groups ?? []).flatMap((group: any) => group?.checks ?? []);
          const targets = (condition?.o?.sIds ?? []).map(String);
          if (!controllerIds.length || !checks.length) broken.push(`${conditionId}: controller/check missing`);
          if (condition?.o?.t !== 'sh') broken.push(`${conditionId}: show output missing`);
          for (const sectionId of targets) {
            if (!(persistedSections[sectionId]?.conditions ?? []).map(String).includes(conditionId)) broken.push(`${conditionId}: section ${sectionId} is not linked`);
          }
        }
        if (Object.keys(persistedConditions).length !== conditionalItems.length || broken.length) {
          results.push({ service: serviceName, status: 'failed', formId, stage: 'conditions-readback', expected: conditionalItems.length, actual: Object.keys(persistedConditions).length, broken, unresolved });
          continue;
        }
        activeDesign = verifyConditions.design ?? activeDesign;
      }

      const publishResponse = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          design: activeDesign,
          publish: {
            jira: { issueCreateIssueTypeIds: [], issueCreateRequestTypeIds: [Number(requestTypeId)], recommendedIssueRequestTypeIds: [], submitOnCreate: true, validateOnCreate: true },
            portal: { portalRequestTypeIds: [Number(requestTypeId)], submitOnCreate: true, validateOnCreate: true }
          }
        })
      });
      await parseJira(publishResponse);
      const finalReadback = await parseJira<{ design?: { conditions?: Record<string, unknown> }; publish?: any }>(
        await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, { headers: { Accept: 'application/json' } })
      );
      const finalConditions = Object.keys(finalReadback.design?.conditions ?? {}).length;
      const portalIds = (finalReadback.publish?.portal?.portalRequestTypeIds ?? []).map(String);
      const jiraIds = (finalReadback.publish?.jira?.issueCreateRequestTypeIds ?? []).map(String);
      if (finalConditions !== conditionalItems.length || (!portalIds.includes(requestTypeId) && !jiraIds.includes(requestTypeId))) {
        results.push({ service: serviceName, status: 'failed', formId, stage: 'publish-readback', expectedConditions: conditionalItems.length, finalConditions, portalIds, jiraIds, unresolved });
        continue;
      }
      results.push({ service: serviceName, status: 'published', baseStatus, formId, requestTypeId, questions: expectedIds.length, sections: layout.length, conditions: finalConditions, unresolved });
    }

    const failed = (results as any[]).filter((item) => item.status === 'failed');
    let workflowResult: unknown;
    let orchestrationResults: unknown[] = [];
    if (!failed.length) {
      const completionPlan = validateCompletionPlan(payload.completionPlan);
      workflowResult = await applyItWorkflowMappings(completionPlan);
      orchestrationResults = await installSourceBackedOrchestration(completionPlan);
    }
    const output = {
      ok: failed.length === 0,
      runId: payload.runId,
      project: { key: PROJECT_KEY, id: PROJECT_ID, name: project.name },
      serviceDeskId: SERVICE_DESK_ID,
      published: (results as any[]).filter((item) => item.status === 'published').length,
      failed: failed.length,
      conditions: (results as any[]).reduce((sum, item) => sum + Number(item.conditions ?? 0), 0),
      unresolvedFieldOccurrences: (results as any[]).reduce((sum, item) => sum + (item.unresolved?.length ?? 0), 0),
      workflowResult,
      orchestrationResults,
      results
    };
    if (!failed.length) {
      await kvs.set(RUN_STATE_KEY, { completedRunId: payload.runId, completedAt: new Date().toISOString() });
    }
    return jsonResponse(failed.length ? 500 : 200, output);
  } catch (error) {
    return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : String(error), detail: (error as any)?.body });
  }
}
