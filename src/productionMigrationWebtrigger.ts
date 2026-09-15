import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

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
  name: string;
  description?: string;
  jiraType?: string;
  required?: boolean;
  sequence?: number;
};
type SourceSection = { name: string; sequence?: number };
type SourceService = { name: string; fields?: SourceField[]; sections?: SourceSection[] };
type Payload = { runId?: string; projectKey?: string; projectId?: string; services?: SourceService[] };
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

function compatible(field: JiraField, requestedType: string): boolean {
  const actual = jiraKind(field);
  if ((field.id === 'summary' || field.id === 'description') && ['text', 'paragraph'].includes(requestedType)) return true;
  if (requestedType === 'checkbox') return actual === 'select';
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

function headerValue(headers: Record<string, string | string[] | undefined> | undefined, name: string): string {
  if (!headers) return '';
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
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

    const jiraFields = await getAllFields();
    const byName = new Map<string, JiraField[]>();
    for (const field of jiraFields) {
      const key = normalise(field.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(field);
    }

    const resolveField = (serviceName: string, source: SourceField): JiraField | undefined => {
      const requestedType = String(source.jiraType ?? 'text');
      if (requestedType === 'lookup-select') return undefined;
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
      const mapped: Array<{ qid: string; sequence: number }> = [];
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
        mapped.push({ qid, sequence: Number(field.sequence ?? 0) });
      }

      const buckets: Array<{ name: string; sequence: number; qids: string[] }> = [];
      if (sections.length) {
        sections.forEach((section) => buckets.push({ name: section.name || 'Section', sequence: Number(section.sequence ?? 0), qids: [] }));
        const pre: string[] = [];
        for (const item of mapped) {
          const eligible = buckets.filter((bucket) => bucket.sequence <= item.sequence);
          if (eligible.length) eligible.sort((a, b) => b.sequence - a.sequence)[0].qids.push(item.qid);
          else pre.push(item.qid);
        }
        if (pre.length) buckets.unshift({ name: 'Request details', sequence: -1, qids: pre });
      } else {
        buckets.push({ name: 'Request details', sequence: 0, qids: mapped.map((item) => item.qid) });
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
      const stored = await parseJira<{ design?: { questions?: Record<string, unknown>; layout?: unknown[] } }>(readResponse);
      const expectedIds = Object.keys(questions);
      const storedIds = Object.keys(stored.design?.questions ?? {});
      const layoutIds = collectQuestionIds(stored.design?.layout ?? []);
      const missingQuestionDefs = expectedIds.filter((id) => !storedIds.includes(id));
      const missingLayout = expectedIds.filter((id) => !layoutIds.includes(id));
      if (missingQuestionDefs.length || missingLayout.length) {
        results.push({ service: serviceName, status: 'failed', formId, stage: 'readback', missingQuestionDefs, missingLayout, unresolved });
        continue;
      }

      const publishResponse = await api.asApp().requestJira(route`/forms/project/${PROJECT_ID}/form/${formId}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          design,
          publish: {
            jira: { issueCreateIssueTypeIds: [], issueCreateRequestTypeIds: [Number(requestTypeId)], recommendedIssueRequestTypeIds: [], submitOnCreate: true, validateOnCreate: true },
            portal: { portalRequestTypeIds: [Number(requestTypeId)], submitOnCreate: true, validateOnCreate: true }
          }
        })
      });
      await parseJira(publishResponse);
      results.push({ service: serviceName, status: 'published', baseStatus, formId, requestTypeId, questions: expectedIds.length, sections: layout.length, unresolved });
    }

    const failed = (results as any[]).filter((item) => item.status === 'failed');
    const output = {
      ok: failed.length === 0,
      runId: payload.runId,
      project: { key: PROJECT_KEY, id: PROJECT_ID, name: project.name },
      serviceDeskId: SERVICE_DESK_ID,
      published: (results as any[]).filter((item) => item.status === 'published').length,
      failed: failed.length,
      unresolvedFieldOccurrences: (results as any[]).reduce((sum, item) => sum + (item.unresolved?.length ?? 0), 0),
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
