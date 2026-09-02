import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';

type JiraField = {
  id: string;
  key?: string;
  name: string;
  custom?: boolean;
  schema?: {
    type?: string;
    custom?: string;
    customId?: number;
  };
};

type JiraStatus = {
  id: string;
  name: string;
  description?: string;
  statusCategory?: { key?: string; name?: string } | string;
};

type FieldRequest = {
  name: string;
  ivantiName?: string;
  description?: string;
  jiraType: keyof typeof FIELD_TYPES;
  options?: string[];
  action?: 'create' | 'reuse' | 'merge' | 'skip';
  existingFieldId?: string;
  existingFieldName?: string;
};

type StepResult = {
  step: 'field' | 'context' | 'options';
  status: 'created' | 'reused' | 'skipped' | 'failed';
  message?: string;
};

type CreationResult = {
  name: string;
  ivantiName?: string;
  status: 'created' | 'reused' | 'partial' | 'failed' | 'skipped';
  id?: string;
  key?: string;
  message?: string;
  steps: StepResult[];
};




type ScreenFieldRequest = {
  id?: string;
  name?: string;
};

type ScreenStructureRequest = {
  serviceName: string;
  issueTypeId: string;
  fields: ScreenFieldRequest[];
};

type ScreenStep = {
  element: 'createScreen' | 'editScreen' | 'viewScreen' | 'screenScheme' | 'issueTypeScreenScheme' | 'fields';
  status: 'created' | 'reused' | 'partial' | 'failed' | 'skipped';
  id?: string;
  name?: string;
  message: string;
};

type ScreenStructureResult = {
  serviceName: string;
  status: 'created' | 'partial' | 'failed';
  createScreenId?: string;
  editScreenId?: string;
  viewScreenId?: string;
  screenSchemeId?: string;
  issueTypeScreenSchemeId?: string;
  steps: ScreenStep[];
};

type ScreenActivationRequest = {
  projectId: string;
  issueTypeScreenSchemeId: string;
};

type JiraStructureRequest = {
  serviceName: string;
  description?: string;
  statuses: string[];
  createIssueType?: boolean;
  createWorkflow?: boolean;
  createWorkflowScheme?: boolean;
};

type ProjectActivationRequest = {
  projectId: string;
  workflowSchemeId: string;
};

type ProjectActivationResult = {
  projectId: string;
  workflowSchemeId: string;
  status: 'assigned' | 'failed';
  message: string;
};

type StructureStep = {
  element: 'issueType' | 'workflow' | 'workflowScheme';
  status: 'created' | 'reused' | 'failed' | 'skipped';
  id?: string;
  name?: string;
  message: string;
};



type HealthCheckItem = {
  key: string;
  label: string;
  status: 'pass' | 'warning' | 'fail';
  message: string;
};

type EnvironmentHealthResult = {
  checkedAt: string;
  ready: boolean;
  project?: { id: string; key: string; name: string; projectTypeKey?: string; simplified?: boolean };
  issueCount?: number;
  checks: HealthCheckItem[];
};

type JiraStructureResult = {
  serviceName: string;
  status: 'created' | 'partial' | 'failed';
  issueTypeId?: string;
  workflowId?: string;
  workflowName?: string;
  workflowSchemeId?: string;
  steps: StructureStep[];
};

const resolver = new Resolver();

const FIELD_TYPES = {
  text: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'
  },
  paragraph: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'
  },
  date: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:daterange'
  },
  select: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'
  },
  // Jira Cloud does not expose a dependable single boolean custom field through
  // this endpoint. Ivanti Yes/No questions are created as single-select fields.
  checkbox: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'
  },
  user: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher'
  },
  number: {
    type: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:exactnumber'
  }
} as const;

type ForgeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
};

type ApiError = Error & { status?: number; body?: unknown };

async function parseResponse<T>(response: ForgeResponse): Promise<T> {
  const text = await response.text();
  let body: unknown = text;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Preserve raw response text.
  }

  if (!response.ok) {
    const candidate = body as {
      errorMessages?: string[];
      errors?: Record<string, unknown>;
      message?: string;
      detail?: string;
      title?: string;
      code?: string;
    };
    const message =
      candidate.errorMessages?.join('; ') ||
      (candidate.errors ? JSON.stringify(candidate.errors) : '') ||
      candidate.detail ||
      candidate.message ||
      candidate.title ||
      text ||
      `${response.status} ${response.statusText}`;
    const error = new Error(`${response.status}: ${message}`) as ApiError;
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body as T;
}

function normaliseOptions(field: FieldRequest): string[] {
  const requested = Array.isArray(field.options) ? field.options : [];
  const values = field.jiraType === 'checkbox' && requested.length === 0
    ? ['Yes', 'No']
    : requested;

  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 100);
}


function structureSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 45);
}

function statusCategory(index: number, total: number): 'TODO' | 'IN_PROGRESS' | 'DONE' {
  if (index === 0) return 'TODO';
  if (index === total - 1) return 'DONE';
  return 'IN_PROGRESS';
}

function normaliseStatusName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function existingStatusCategory(status: JiraStatus, index: number, total: number): 'TODO' | 'IN_PROGRESS' | 'DONE' {
  const raw = typeof status.statusCategory === 'string'
    ? status.statusCategory
    : status.statusCategory?.key || status.statusCategory?.name || '';
  const value = raw.toLowerCase();

  if (value.includes('done') || value.includes('complete')) return 'DONE';
  if (value.includes('progress') || value.includes('flight')) return 'IN_PROGRESS';
  if (value.includes('todo') || value.includes('to do') || value.includes('new')) return 'TODO';
  return statusCategory(index, total);
}

async function getAllStatuses(): Promise<JiraStatus[]> {
  const response = await api.asUser().requestJira(route`/rest/api/3/status`, {
    headers: { Accept: 'application/json' }
  });
  return parseResponse<JiraStatus[]>(response);
}

function workflowPayload(
  serviceName: string,
  description: string,
  requestedStatuses: string[],
  jiraStatuses: JiraStatus[]
) {
  const statuses = [...new Set(requestedStatuses.map((value) => String(value).trim()).filter(Boolean))];
  const safeStatuses = statuses.length >= 2 ? statuses : ['Submitted', 'In Progress', 'Completed'];
  const refs = safeStatuses.map(() => crypto.randomUUID());
  const existingByName = new Map(
    jiraStatuses
      .filter((status) => normaliseStatusName(status?.name))
      .map((status) => [normaliseStatusName(status.name), status])
  );

  const resolvedStatuses = safeStatuses.map((name, index) => {
    const existing = existingByName.get(normaliseStatusName(name));
    return existing
      ? {
          id: existing.id,
          description: existing.description || `Reused by Ivanti Migration Assistant for ${serviceName}.`,
          name: existing.name,
          statusCategory: existingStatusCategory(existing, index, safeStatuses.length),
          statusReference: refs[index]
        }
      : {
          description: `Created by Ivanti Migration Assistant for ${serviceName}.`,
          name,
          statusCategory: statusCategory(index, safeStatuses.length),
          statusReference: refs[index]
        };
  });

  return {
    scope: { type: 'GLOBAL' },
    statuses: resolvedStatuses,
    workflows: [{
      description: description || `Migrated workflow for ${serviceName}.`,
      name: `${serviceName} - Ivanti Migration`,
      startPointLayout: { x: 0, y: 0 },
      statuses: safeStatuses.map((_name, index) => ({
        layout: { x: 160 + (index * 220), y: 80 },
        properties: {},
        statusReference: refs[index]
      })),
      transitions: [
        {
          actions: [],
          description: 'Initial transition created by Ivanti Migration Assistant.',
          id: '1',
          links: [],
          name: 'Create',
          properties: {},
          toStatusReference: refs[0],
          triggers: [],
          type: 'INITIAL',
          validators: []
        },
        ...safeStatuses.map((name, index) => ({
          actions: [],
          description: `Move the request to ${name}.`,
          id: String(10 + (index * 10)),
          links: [],
          name,
          properties: {},
          toStatusReference: refs[index],
          triggers: [],
          type: 'GLOBAL',
          validators: []
        }))
      ]
    }]
  };
}

async function getIssueTypes(): Promise<Array<{ id: string; name: string; description?: string; subtask?: boolean }>> {
  const response = await api.asUser().requestJira(route`/rest/api/3/issuetype`, {
    headers: { Accept: 'application/json' }
  });
  return parseResponse(response);
}

async function findWorkflowByName(name: string): Promise<{ id?: string; name: string } | undefined> {
  const targetName = normaliseStatusName(name);
  if (!targetName) return undefined;

  // Prefer Jira's current workflow-search API. It returns workflow IDs directly
  // and supports exact workflow-name filtering. The legacy endpoint is retained
  // as a fallback for Jira sites where the newer API is not yet available.
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/workflows/search?workflowName=${name}&maxResults=50`,
      { headers: { Accept: 'application/json' } }
    );
    const body = await parseResponse<{
      values?: Array<{ id?: string; name?: string }>
    }>(response);
    const match = (body.values ?? []).find(
      (workflow) => normaliseStatusName(workflow?.name) === targetName
    );
    if (match?.name) return { id: match.id, name: match.name };
  } catch (error) {
    const status = (error as ApiError)?.status;
    if (status !== 404 && status !== 400) throw error;
  }

  const legacyResponse = await api.asUser().requestJira(
    route`/rest/api/3/workflow/search?workflowName=${name}&maxResults=50`,
    { headers: { Accept: 'application/json' } }
  );
  const legacyBody = await parseResponse<{
    values?: Array<{
      id?: { entityId?: string; name?: string };
      entityId?: string;
      name?: string;
    }>;
  }>(legacyResponse);
  const legacyMatch = (legacyBody.values ?? []).find((workflow) => {
    const workflowName = workflow?.name || workflow?.id?.name;
    return normaliseStatusName(workflowName) === targetName;
  });
  const legacyName = legacyMatch?.name || legacyMatch?.id?.name;
  return legacyMatch && legacyName
    ? { id: legacyMatch.id?.entityId || legacyMatch.entityId, name: legacyName }
    : undefined;
}


resolver.define('getProjects', async () => {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/project/search?maxResults=100&orderBy=name`,
    { headers: { Accept: 'application/json' } }
  );
  const body = await parseResponse<{ values?: Array<Record<string, unknown>> }>(response);

  return (body.values ?? []).map((project) => ({
    id: String(project.id ?? ''),
    key: String(project.key ?? ''),
    name: String(project.name ?? ''),
    projectTypeKey: String(project.projectTypeKey ?? ''),
    simplified: Boolean(project.simplified)
  }));
});


resolver.define('getFields', async () => {
  const response = await api.asUser().requestJira(route`/rest/api/3/field`, {
    headers: { Accept: 'application/json' }
  });

  const fields = await parseResponse<JiraField[]>(response);

  return fields.map((field) => ({
    id: field.id,
    key: field.key,
    name: field.name,
    custom: Boolean(field.custom),
    schema: field.schema
      ? {
          type: field.schema.type,
          custom: field.schema.custom,
          customId: field.schema.customId
        }
      : undefined
  }));
});


async function getFirstContextId(fieldId: string): Promise<string> {
  const contextResponse = await api.asUser().requestJira(
    route`/rest/api/3/field/${fieldId}/context?maxResults=50`,
    { headers: { Accept: 'application/json' } }
  );
  const contextBody = await parseResponse<{ values?: Array<{ id: string; name?: string }> }>(contextResponse);
  const context = contextBody.values?.[0];
  if (!context?.id) throw new Error(`No context was returned for ${fieldId}.`);
  return context.id;
}

async function addMissingOptions(fieldId: string, requestedOptions: string[]): Promise<{
  contextId: string;
  added: string[];
  existing: string[];
}> {
  const contextId = await getFirstContextId(fieldId);
  const existingResponse = await api.asUser().requestJira(
    route`/rest/api/3/field/${fieldId}/context/${contextId}/option?maxResults=1000`,
    { headers: { Accept: 'application/json' } }
  );
  const existingBody = await parseResponse<{ values?: Array<{ id: string; value: string; disabled?: boolean }> }>(existingResponse);
  const existing = (existingBody.values ?? []).map((option) => option.value);
  const existingSet = new Set(existing.map((value) => normaliseStatusName(value)));
  const missing = requestedOptions.filter((value) => !existingSet.has(normaliseStatusName(value)));

  if (missing.length > 0) {
    const optionResponse = await api.asUser().requestJira(
      route`/rest/api/3/field/${fieldId}/context/${contextId}/option`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ options: missing.map((value) => ({ value })) })
      }
    );
    await parseResponse(optionResponse);
  }

  return { contextId, added: missing, existing };
}

resolver.define('createFields', async ({ payload }) => {
  const requested = Array.isArray(payload?.fields) ? (payload.fields as FieldRequest[]) : [];
  if (requested.length === 0) throw new Error('No fields were selected.');

  const existingResponse = await api.asUser().requestJira(route`/rest/api/3/field`, {
    headers: { Accept: 'application/json' }
  });
  const existing = await parseResponse<JiraField[]>(existingResponse);
  const existingByName = new Map(existing.filter((field) => normaliseStatusName(field?.name)).map((field) => [normaliseStatusName(field.name), field]));
  const results: CreationResult[] = [];

  for (const field of requested) {
    const name = String(field.name ?? '').trim();
    const steps: StepResult[] = [];

    if (!name) {
      results.push({
        name: 'Unnamed field',
        ivantiName: field.ivantiName,
        status: 'skipped',
        message: 'Blank Jira field name.',
        steps: [{ step: 'field', status: 'skipped', message: 'Blank Jira field name.' }]
      });
      continue;
    }

    const requestedAction = field.action ?? 'create';

    if (requestedAction === 'skip') {
      results.push({
        name,
        ivantiName: field.ivantiName,
        status: 'skipped',
        message: 'Skipped by migration mapping.',
        steps: [{ step: 'field', status: 'skipped', message: 'Skipped by migration mapping.' }]
      });
      continue;
    }

    if ((requestedAction === 'reuse' || requestedAction === 'merge') && field.existingFieldId) {
      const existingField = existing.find((item) => item.id === field.existingFieldId);
      if (!existingField) {
        results.push({
          name,
          ivantiName: field.ivantiName,
          status: 'failed',
          message: `The selected existing Jira field ${field.existingFieldId} was not found.`,
          steps: [{ step: 'field', status: 'failed', message: 'Selected existing field was not found.' }]
        });
        continue;
      }

      if (requestedAction === 'reuse') {
        results.push({
          name,
          ivantiName: field.ivantiName,
          status: 'reused',
          id: existingField.id,
          key: existingField.key,
          message: `Reused existing Jira field: ${existingField.name}.`,
          steps: [{ step: 'field', status: 'reused', message: `Reused ${existingField.id}.` }]
        });
        continue;
      }

      const mergeOptions = normaliseOptions(field);
      if (mergeOptions.length === 0 || (field.jiraType !== 'select' && field.jiraType !== 'checkbox')) {
        results.push({
          name,
          ivantiName: field.ivantiName,
          status: 'reused',
          id: existingField.id,
          key: existingField.key,
          message: `Reused ${existingField.name}; no options required merging.`,
          steps: [
            { step: 'field', status: 'reused', message: `Reused ${existingField.id}.` },
            { step: 'options', status: 'skipped', message: 'No options required.' }
          ]
        });
        continue;
      }

      try {
        const merged = await addMissingOptions(existingField.id, mergeOptions);
        results.push({
          name,
          ivantiName: field.ivantiName,
          status: 'reused',
          id: existingField.id,
          key: existingField.key,
          message: merged.added.length
            ? `Reused ${existingField.name} and added ${merged.added.length} missing option(s).`
            : `Reused ${existingField.name}; all requested options already exist.`,
          steps: [
            { step: 'field', status: 'reused', message: `Reused ${existingField.id}.` },
            { step: 'context', status: 'reused', message: `Using context ${merged.contextId}.` },
            {
              step: 'options',
              status: merged.added.length ? 'created' : 'reused',
              message: merged.added.length
                ? `Added: ${merged.added.join(', ')}.`
                : 'No missing options.'
            }
          ]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          name,
          ivantiName: field.ivantiName,
          status: 'partial',
          id: existingField.id,
          key: existingField.key,
          message: `The field was reused, but options could not be merged: ${message}`,
          steps: [
            { step: 'field', status: 'reused', message: `Reused ${existingField.id}.` },
            { step: 'options', status: 'failed', message }
          ]
        });
      }
      continue;
    }

    const duplicate = existingByName.get(name.toLowerCase());
    if (duplicate) {
      results.push({
        name,
        ivantiName: field.ivantiName,
        status: 'reused',
        id: duplicate.id,
        message: 'An exact-name Jira field already exists; no changes were made to it.',
        steps: [{ step: 'field', status: 'reused', message: `Reused ${duplicate.id}.` }]
      });
      continue;
    }

    const definition = FIELD_TYPES[field.jiraType] ?? FIELD_TYPES.text;
    let created: JiraField;

    try {
      const createResponse = await api.asUser().requestJira(route`/rest/api/3/field`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description:
            String(field.description ?? '').trim() ||
            `Migrated from Ivanti field: ${field.ivantiName || name}`,
          type: definition.type,
          searcherKey: definition.searcherKey
        })
      });
      created = await parseResponse<JiraField>(createResponse);
      existingByName.set(name.toLowerCase(), created);
      steps.push({ step: 'field', status: 'created', message: `Created ${created.id}.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        name,
        ivantiName: field.ivantiName,
        status: 'failed',
        message,
        steps: [{ step: 'field', status: 'failed', message }]
      });
      continue;
    }

    const options = normaliseOptions(field);
    if (options.length === 0 || (field.jiraType !== 'select' && field.jiraType !== 'checkbox')) {
      steps.push({ step: 'options', status: 'skipped', message: 'No options required.' });
      results.push({
        name,
        ivantiName: field.ivantiName,
        status: 'created',
        id: created.id,
        key: created.key,
        message: 'Field created successfully.',
        steps
      });
      continue;
    }

    try {
      const contextResponse = await api.asUser().requestJira(
        route`/rest/api/3/field/${created.id}/context?maxResults=50`,
        { headers: { Accept: 'application/json' } }
      );
      const contextBody = await parseResponse<{ values?: Array<{ id: string; name?: string }> }>(contextResponse);
      const context = contextBody.values?.[0];
      if (!context?.id) throw new Error('Jira created the field, but no field context was returned.');
      steps.push({ step: 'context', status: 'reused', message: `Using context ${context.id}.` });

      const optionResponse = await api.asUser().requestJira(
        route`/rest/api/3/field/${created.id}/context/${context.id}/option`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ options: options.map((value) => ({ value })) })
        }
      );
      await parseResponse(optionResponse);
      steps.push({ step: 'options', status: 'created', message: `Created ${options.length} option(s): ${options.join(', ')}.` });
      results.push({
        name,
        ivantiName: field.ivantiName,
        status: 'created',
        id: created.id,
        key: created.key,
        message: 'Field and options created successfully.',
        steps
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ step: 'options', status: 'failed', message });
      results.push({
        name,
        ivantiName: field.ivantiName,
        status: 'partial',
        id: created.id,
        key: created.key,
        message: `The field was created, but its options were not: ${message}`,
        steps
      });
    }
  }

  return results;
});


resolver.define('createJiraStructure', async ({ payload }) => {
  const request = payload as JiraStructureRequest;
  const serviceName = String(request?.serviceName ?? '').trim();
  if (!serviceName) throw new Error('A service name is required.');

  const description = String(request?.description ?? '').trim();
  const steps: StructureStep[] = [];
  let issueTypeId: string | undefined;
  let workflowId: string | undefined;
  let workflowName: string | undefined;
  let workflowSchemeId: string | undefined;

  if (request.createIssueType !== false) {
    try {
      const issueTypes = await getIssueTypes();
      const existing = issueTypes.find((item) => normaliseStatusName(item?.name) === normaliseStatusName(serviceName));

      if (existing) {
        issueTypeId = existing.id;
        steps.push({
          element: 'issueType',
          status: 'reused',
          id: existing.id,
          name: existing.name,
          message: `Reused existing issue type ${existing.name}.`
        });
      } else {
        const response = await api.asUser().requestJira(route`/rest/api/3/issuetype`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: serviceName,
            description: description || `Migrated Ivanti service: ${serviceName}`,
            type: 'standard',
            hierarchyLevel: 0
          })
        });
        const created = await parseResponse<{ id: string; name: string }>(response);
        issueTypeId = created.id;
        steps.push({
          element: 'issueType',
          status: 'created',
          id: created.id,
          name: created.name,
          message: `Created issue type ${created.name}.`
        });
      }
    } catch (error) {
      steps.push({
        element: 'issueType',
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    steps.push({ element: 'issueType', status: 'skipped', message: 'Issue type creation was not selected.' });
  }

  if (request.createWorkflow !== false) {
    workflowName = `${serviceName} - Ivanti Migration`;
    try {
      const existingWorkflow = await findWorkflowByName(workflowName);
      if (existingWorkflow) {
        workflowId = existingWorkflow.id;
        steps.push({
          element: 'workflow',
          status: 'reused',
          id: workflowId,
          name: workflowName,
          message: `Reused existing workflow ${workflowName}.`
        });
      } else {
        const jiraStatuses = await getAllStatuses();
        const payloadBody = workflowPayload(serviceName, description, request.statuses ?? [], jiraStatuses);
        const validationResponse = await api.asUser().requestJira(route`/rest/api/3/workflows/create/validation`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payload: payloadBody,
            validationOptions: { levels: ['ERROR', 'WARNING'] }
          })
        });
        const validation = await parseResponse<unknown>(validationResponse);

        const createResponse = await api.asUser().requestJira(route`/rest/api/3/workflows/create`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(payloadBody)
        });
        const created = await parseResponse<{
          workflows?: Array<{ id?: string; name: string }>
        }>(createResponse);
        const workflow = created.workflows?.[0];
        workflowId = workflow?.id;
        workflowName = String(workflow?.name ?? '').trim() || workflowName;
        steps.push({
          element: 'workflow',
          status: 'created',
          id: workflowId,
          name: workflowName,
          message: `Created workflow ${workflowName}. Validation completed before creation.`
        });
      }
    } catch (error) {
      steps.push({
        element: 'workflow',
        status: 'failed',
        name: workflowName,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  } else {
    steps.push({ element: 'workflow', status: 'skipped', message: 'Workflow creation was not selected.' });
  }

  if (request.createWorkflowScheme !== false) {
    if (!workflowName || !issueTypeId) {
      steps.push({
        element: 'workflowScheme',
        status: 'skipped',
        message: 'A workflow and issue type are required before creating the workflow scheme.'
      });
    } else {
      const schemeName = `${serviceName} - Ivanti Migration Scheme`;
      try {
        const schemesResponse = await api.asUser().requestJira(
          route`/rest/api/3/workflowscheme?maxResults=100`,
          { headers: { Accept: 'application/json' } }
        );
        const schemesBody = await parseResponse<{
          values?: Array<{ id: number; name: string }>
        }>(schemesResponse);
        const existingScheme = (schemesBody.values ?? []).find(
          (scheme) => normaliseStatusName(scheme?.name) === normaliseStatusName(schemeName)
        );

        if (existingScheme) {
          workflowSchemeId = String(existingScheme.id);
          steps.push({
            element: 'workflowScheme',
            status: 'reused',
            id: workflowSchemeId,
            name: schemeName,
            message: `Reused existing workflow scheme ${schemeName}.`
          });
        } else {
          const schemeResponse = await api.asUser().requestJira(route`/rest/api/3/workflowscheme`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: schemeName,
              description: `Created by Ivanti Migration Assistant for ${serviceName}.`,
              defaultWorkflow: workflowName,
              issueTypeMappings: { [issueTypeId]: workflowName }
            })
          });
          const scheme = await parseResponse<{ id: number; name: string }>(schemeResponse);
          workflowSchemeId = String(scheme.id);
          steps.push({
            element: 'workflowScheme',
            status: 'created',
            id: workflowSchemeId,
            name: scheme.name,
            message: `Created inactive workflow scheme ${scheme.name}.`
          });
        }
      } catch (error) {
        steps.push({
          element: 'workflowScheme',
          status: 'failed',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } else {
    steps.push({ element: 'workflowScheme', status: 'skipped', message: 'Workflow scheme creation was not selected.' });
  }

  const failures = steps.filter((step) => step.status === 'failed').length;
  const successes = steps.filter((step) => step.status === 'created' || step.status === 'reused').length;

  return {
    serviceName,
    status: failures === 0 ? 'created' : successes > 0 ? 'partial' : 'failed',
    issueTypeId,
    workflowId,
    workflowName,
    workflowSchemeId,
    steps
  } satisfies JiraStructureResult;
});


resolver.define('assignWorkflowSchemeToProject', async ({ payload }) => {
  const request = payload as ProjectActivationRequest;
  const projectId = String(request?.projectId ?? '').trim();
  const workflowSchemeId = String(request?.workflowSchemeId ?? '').trim();
  if (!projectId) throw new Error('Choose a target Jira project first.');
  if (!workflowSchemeId) throw new Error('Create or reuse a workflow scheme first.');

  const projectResponse = await api.asUser().requestJira(route`/rest/api/3/project/${projectId}`, {
    headers: { Accept: 'application/json' }
  });
  const project = await parseResponse<{ id: string; key: string; name: string; simplified?: boolean }>(projectResponse);
  if (project.simplified) {
    throw new Error('Workflow schemes can only be assigned to company-managed Jira projects.');
  }

  const response = await api.asUser().requestJira(route`/rest/api/3/workflowscheme/project`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, workflowSchemeId })
  });
  await parseResponse<unknown>(response);

  return {
    projectId,
    workflowSchemeId,
    status: 'assigned',
    message: `Assigned workflow scheme ${workflowSchemeId} to ${project.name} (${project.key}).`
  } satisfies ProjectActivationResult;
});



async function getOrCreateScreen(name: string, description: string): Promise<{ id: string; name: string; reused: boolean }> {
  const listResponse = await api.asUser().requestJira(route`/rest/api/3/screens?maxResults=100`, {
    headers: { Accept: 'application/json' }
  });
  const list = await parseResponse<{ values?: Array<{ id: number | string; name: string }> }>(listResponse);
  const existing = (list.values ?? []).find((item) => normaliseStatusName(item?.name) === normaliseStatusName(name));
  if (existing) return { id: String(existing.id), name: existing.name, reused: true };

  const response = await api.asUser().requestJira(route`/rest/api/3/screens`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description })
  });
  const created = await parseResponse<{ id: number | string; name?: string }>(response);
  return { id: String(created.id), name: created.name || name, reused: false };
}

async function getAllCustomFieldsForScreenResolution(): Promise<JiraField[]> {
  const all: JiraField[] = [];
  let startAt = 0;
  const maxResults = 100;

  // GET /field omits custom fields that are not yet used on a screen or field
  // configuration. The paginated /field/search endpoint is therefore required
  // for a migration builder that is trying to place newly-created fields onto
  // their first screen.
  for (let page = 0; page < 100; page += 1) {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/field/search?type=custom&startAt=${startAt}&maxResults=${maxResults}`,
      { headers: { Accept: 'application/json' } }
    );
    const body = await parseResponse<{
      values?: JiraField[];
      startAt?: number;
      maxResults?: number;
      total?: number;
      isLast?: boolean;
    }>(response);

    const values = body.values ?? [];
    all.push(...values);

    if (body.isLast === true || values.length === 0) break;
    const nextStart = Number(body.startAt ?? startAt) + Number(body.maxResults ?? maxResults);
    if (Number.isFinite(body.total) && nextStart >= Number(body.total)) break;
    startAt = nextStart;
  }

  return all;
}

async function resolveScreenFields(fields: ScreenFieldRequest[]): Promise<{ resolved: ScreenFieldRequest[]; missing: string[] }> {
  // System fields are easy to obtain from /field. Newly-created custom fields may
  // be deliberately absent from that endpoint until they have been placed on a
  // screen, so combine it with the paginated custom-field catalogue.
  const systemResponse = await api.asUser().requestJira(route`/rest/api/3/field`, {
    headers: { Accept: 'application/json' }
  });
  const visibleFields = await parseResponse<JiraField[]>(systemResponse);
  const customFields = await getAllCustomFieldsForScreenResolution();

  const jiraFields = [...new Map(
    [...visibleFields, ...customFields]
      .filter((field) => field?.id)
      .map((field) => [String(field.id), field])
  ).values()];

  const byId = new Map(jiraFields.map((field) => [String(field.id), field]));
  const byName = new Map<string, JiraField>();

  // Prefer custom fields when duplicate names exist because migrated Ivanti fields
  // are normally Jira custom fields.
  [...jiraFields]
    .sort((left, right) => Number(Boolean(right.custom)) - Number(Boolean(left.custom)))
    .forEach((field) => {
      const key = normaliseStatusName(field.name);
      if (key && !byName.has(key)) byName.set(key, field);
    });

  const resolved: ScreenFieldRequest[] = [];
  const missing: string[] = [];

  for (const requested of fields) {
    const requestedId = String(requested?.id ?? '').trim();
    const requestedName = String(requested?.name ?? '').trim();
    const match = (requestedId && byId.get(requestedId)) || (requestedName && byName.get(normaliseStatusName(requestedName)));

    if (!match) {
      if (requestedName || requestedId) missing.push(requestedName || requestedId);
      continue;
    }

    resolved.push({ id: String(match.id), name: match.name || requestedName || String(match.id) });
  }

  const unique = [...new Map(resolved.map((field) => [String(field.id), field])).values()];
  return { resolved: unique, missing: [...new Set(missing)] };
}

async function addFieldsToScreen(screenId: string, fields: ScreenFieldRequest[]): Promise<{ added: number; reused: number; failed: string[] }> {
  const tabsResponse = await api.asUser().requestJira(route`/rest/api/3/screens/${screenId}/tabs`, {
    headers: { Accept: 'application/json' }
  });
  const tabs = await parseResponse<Array<{ id: number | string; name?: string }>>(tabsResponse);
  const tab = tabs?.[0];
  if (!tab?.id) throw new Error(`Screen ${screenId} has no default tab.`);

  const existingResponse = await api.asUser().requestJira(route`/rest/api/3/screens/${screenId}/tabs/${tab.id}/fields`, {
    headers: { Accept: 'application/json' }
  });
  const existing = await parseResponse<Array<{ id: string; name?: string }>>(existingResponse);
  const existingIds = new Set((existing ?? []).map((field) => String(field.id)));
  let added = 0;
  let reused = 0;
  const failed: string[] = [];

  for (const field of fields) {
    const fieldId = String(field?.id ?? '').trim();
    if (!fieldId) continue;
    if (existingIds.has(fieldId)) { reused += 1; continue; }
    try {
      const response = await api.asUser().requestJira(route`/rest/api/3/screens/${screenId}/tabs/${tab.id}/fields`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldId })
      });
      await parseResponse(response);
      existingIds.add(fieldId);
      added += 1;
    } catch (error) {
      failed.push(`${field.name || fieldId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { added, reused, failed };
}


async function ensureIssueTypeScreenSchemeMappings(
  issueTypeScreenSchemeId: string,
  screenSchemeId: string,
  issueTypeId: string
): Promise<void> {
  const mappingsResponse = await api.asUser().requestJira(
    route`/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${issueTypeScreenSchemeId}&maxResults=100`,
    { headers: { Accept: 'application/json' } }
  );
  const mappingsBody = await parseResponse<{
    values?: Array<{ issueTypeId: string; issueTypeScreenSchemeId: string; screenSchemeId: string }>;
  }>(mappingsResponse);
  const mappings = (mappingsBody.values ?? []).filter(
    (item) => String(item.issueTypeScreenSchemeId) === String(issueTypeScreenSchemeId)
  );

  const defaultMapping = mappings.find((item) => item.issueTypeId === 'default');
  if (!defaultMapping || String(defaultMapping.screenSchemeId) !== String(screenSchemeId)) {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issuetypescreenscheme/${issueTypeScreenSchemeId}/mapping/default`,
      {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenSchemeId: String(screenSchemeId) })
      }
    );
    await parseResponse(response);
  }

  const issueMapping = mappings.find((item) => String(item.issueTypeId) === String(issueTypeId));
  if (issueMapping && String(issueMapping.screenSchemeId) !== String(screenSchemeId)) {
    const removeResponse = await api.asUser().requestJira(
      route`/rest/api/3/issuetypescreenscheme/${issueTypeScreenSchemeId}/mapping/remove`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueTypeIds: [String(issueTypeId)] })
      }
    );
    await parseResponse(removeResponse);
  }

  if (!issueMapping || String(issueMapping.screenSchemeId) !== String(screenSchemeId)) {
    const appendResponse = await api.asUser().requestJira(
      route`/rest/api/3/issuetypescreenscheme/${issueTypeScreenSchemeId}/mapping`,
      {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueTypeMappings: [{ issueTypeId: String(issueTypeId), screenSchemeId: String(screenSchemeId) }]
        })
      }
    );
    await parseResponse(appendResponse);
  }
}

resolver.define('createScreenStructure', async ({ payload }) => {
  const request = payload as ScreenStructureRequest;
  const serviceName = String(request?.serviceName ?? '').trim();
  const issueTypeId = String(request?.issueTypeId ?? '').trim();
  if (!serviceName) throw new Error('A service name is required.');
  if (!issueTypeId) throw new Error('Create or reuse the Jira issue type first.');

  const requestedFields = Array.isArray(request.fields) ? request.fields : [];
  const steps: ScreenStep[] = [];

  try {
    const createScreen = await getOrCreateScreen(`${serviceName} - Create Screen`, `Create screen generated for ${serviceName}.`);
    const editScreen = await getOrCreateScreen(`${serviceName} - Edit Screen`, `Edit screen generated for ${serviceName}.`);
    const viewScreen = await getOrCreateScreen(`${serviceName} - View Screen`, `View screen generated for ${serviceName}.`);

    for (const [element, screen] of [
      ['createScreen', createScreen], ['editScreen', editScreen], ['viewScreen', viewScreen]
    ] as const) {
      steps.push({ element, status: screen.reused ? 'reused' : 'created', id: screen.id, name: screen.name, message: `${screen.reused ? 'Reused' : 'Created'} ${screen.name}.` });
    }

    const baseFields: ScreenFieldRequest[] = [
      { id: 'summary', name: 'Summary' },
      { id: 'description', name: 'Description' },
      { id: 'reporter', name: 'Reporter' },
      { id: 'assignee', name: 'Assignee' },
      ...requestedFields
    ];
    const resolution = await resolveScreenFields(baseFields);
    const uniqueFields = resolution.resolved;
    const expectedMigrated = requestedFields.filter((field) => String(field?.name ?? field?.id ?? '').trim()).length;
    const resolvedMigrated = uniqueFields.filter((field) => !['summary', 'description', 'reporter', 'assignee'].includes(String(field.id))).length;

    const screenTargets = [
      { label: 'Create', id: createScreen.id },
      { label: 'Edit', id: editScreen.id },
      { label: 'View', id: viewScreen.id }
    ];
    const fieldResults = await Promise.all(screenTargets.map(async (target) => ({
      target,
      result: await addFieldsToScreen(target.id, uniqueFields)
    })));

    const failures = fieldResults.flatMap(({ result }) => result.failed);
    const verificationProblems: string[] = [];
    for (const { target, result } of fieldResults) {
      const processed = result.added + result.reused;
      if (processed !== uniqueFields.length) {
        verificationProblems.push(`${target.label}: expected ${uniqueFields.length}, processed ${processed}`);
      }
    }
    if (resolution.missing.length) verificationProblems.push(`Unresolved Jira fields: ${resolution.missing.join(', ')}`);

    const perScreen = fieldResults
      .map(({ target, result }) => `${target.label} ${result.added} added / ${result.reused} present`)
      .join('; ');
    const totalAdded = fieldResults.reduce((sum, item) => sum + item.result.added, 0);
    const problemCount = failures.length + verificationProblems.length;

    steps.push({
      element: 'fields',
      status: problemCount ? 'partial' : totalAdded ? 'created' : 'reused',
      message: `Migrated fields resolved: ${resolvedMigrated}/${expectedMigrated}. Expected on each screen: ${uniqueFields.length} total fields (${resolvedMigrated} migrated + ${uniqueFields.length - resolvedMigrated} standard). ${perScreen}.${problemCount ? ` Review: ${[...verificationProblems, ...failures].slice(0, 8).join(' | ')}` : ' All expected fields verified.'}`
    });

    const screenSchemeName = `${serviceName} - Screen Scheme`;
    const schemesResponse = await api.asUser().requestJira(route`/rest/api/2/screenscheme?maxResults=100`, { headers: { Accept: 'application/json' } });
    const schemes = await parseResponse<{ values?: Array<{ id: number | string; name: string }> }>(schemesResponse);
    let screenSchemeId: string;
    const existingScheme = (schemes.values ?? []).find((item) => normaliseStatusName(item?.name) === normaliseStatusName(screenSchemeName));
    if (existingScheme) {
      screenSchemeId = String(existingScheme.id);
      steps.push({ element: 'screenScheme', status: 'reused', id: screenSchemeId, name: screenSchemeName, message: `Reused existing screen scheme ${screenSchemeName}.` });
    } else {
      const response = await api.asUser().requestJira(route`/rest/api/2/screenscheme`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: screenSchemeName,
          description: `Created by Ivanti Migration Assistant for ${serviceName}.`,
          screens: { default: Number(viewScreen.id), create: Number(createScreen.id), edit: Number(editScreen.id), view: Number(viewScreen.id) }
        })
      });
      const created = await parseResponse<{ id: number | string }>(response);
      screenSchemeId = String(created.id);
      steps.push({ element: 'screenScheme', status: 'created', id: screenSchemeId, name: screenSchemeName, message: `Created screen scheme ${screenSchemeName}.` });
    }

    const issueTypeScreenSchemeName = `${serviceName} - Issue Type Screen Scheme`;
    const issueSchemesResponse = await api.asUser().requestJira(route`/rest/api/3/issuetypescreenscheme?maxResults=100`, { headers: { Accept: 'application/json' } });
    const issueSchemes = await parseResponse<{ values?: Array<{ id: string; name: string }> }>(issueSchemesResponse);
    let issueTypeScreenSchemeId: string;
    const existingIssueScheme = (issueSchemes.values ?? []).find((item) => normaliseStatusName(item?.name) === normaliseStatusName(issueTypeScreenSchemeName));
    if (existingIssueScheme) {
      issueTypeScreenSchemeId = String(existingIssueScheme.id);
      await ensureIssueTypeScreenSchemeMappings(issueTypeScreenSchemeId, screenSchemeId, issueTypeId);
      steps.push({ element: 'issueTypeScreenScheme', status: 'reused', id: issueTypeScreenSchemeId, name: issueTypeScreenSchemeName, message: `Reused existing issue type screen scheme ${issueTypeScreenSchemeName}; default and issue-type mappings verified.` });
    } else {
      const response = await api.asUser().requestJira(route`/rest/api/3/issuetypescreenscheme`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: issueTypeScreenSchemeName,
          description: `Created by Ivanti Migration Assistant for ${serviceName}.`,
          issueTypeMappings: [
            { issueTypeId: 'default', screenSchemeId: String(screenSchemeId) },
            { issueTypeId: String(issueTypeId), screenSchemeId: String(screenSchemeId) }
          ]
        })
      });
      const created = await parseResponse<{ id: string }>(response);
      issueTypeScreenSchemeId = String(created.id);
      steps.push({ element: 'issueTypeScreenScheme', status: 'created', id: issueTypeScreenSchemeId, name: issueTypeScreenSchemeName, message: `Created issue type screen scheme ${issueTypeScreenSchemeName} with a default mapping.` });
    }

    const failuresCount = steps.filter((step) => step.status === 'failed').length;
    const partialCount = steps.filter((step) => step.status === 'partial').length;
    return {
      serviceName,
      status: failuresCount ? 'failed' : partialCount ? 'partial' : 'created',
      createScreenId: createScreen.id, editScreenId: editScreen.id, viewScreenId: viewScreen.id,
      screenSchemeId, issueTypeScreenSchemeId, steps
    } satisfies ScreenStructureResult;
  } catch (error) {
    steps.push({ element: 'screenScheme', status: 'failed', message: error instanceof Error ? error.message : String(error) });
    return { serviceName, status: 'failed', steps } satisfies ScreenStructureResult;
  }
});

resolver.define('assignIssueTypeScreenSchemeToProject', async ({ payload }) => {
  const request = payload as ScreenActivationRequest;
  const projectId = String(request?.projectId ?? '').trim();
  const issueTypeScreenSchemeId = String(request?.issueTypeScreenSchemeId ?? '').trim();
  if (!projectId) throw new Error('Choose a target Jira project first.');
  if (!issueTypeScreenSchemeId) throw new Error('Create or reuse the issue type screen scheme first.');

  const response = await api.asUser().requestJira(route`/rest/api/3/issuetypescreenscheme/project`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, issueTypeScreenSchemeId })
  });
  await parseResponse(response);
  return { projectId, issueTypeScreenSchemeId, status: 'assigned', message: `Assigned issue type screen scheme ${issueTypeScreenSchemeId} to project ${projectId}.` };
});

resolver.define('getEnvironmentHealth', async ({ payload }) => {
  const projectId = String(payload?.projectId ?? '').trim();
  const checks: HealthCheckItem[] = [];
  let project: EnvironmentHealthResult['project'];
  let issueCount = 0;

  // Global Jira configuration access.
  try {
    const fieldResponse = await api.asUser().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
    await parseResponse<unknown>(fieldResponse);
    checks.push({ key: 'configuration', label: 'Jira configuration access', status: 'pass', message: 'The app can read Jira configuration.' });
  } catch (error) {
    checks.push({ key: 'configuration', label: 'Jira configuration access', status: 'fail', message: error instanceof Error ? error.message : String(error) });
  }

  try {
    const statusResponse = await api.asUser().requestJira(route`/rest/api/3/status`, { headers: { Accept: 'application/json' } });
    const statuses = await parseResponse<JiraStatus[]>(statusResponse);
    checks.push({ key: 'statuses', label: 'Status access', status: 'pass', message: `${statuses.length} Jira statuses are available for reuse.` });
  } catch (error) {
    checks.push({ key: 'statuses', label: 'Status access', status: 'fail', message: error instanceof Error ? error.message : String(error) });
  }

  try {
    const workflowResponse = await api.asUser().requestJira(route`/rest/api/3/workflow/search?maxResults=1`, { headers: { Accept: 'application/json' } });
    await parseResponse<unknown>(workflowResponse);
    checks.push({ key: 'workflows', label: 'Workflow administration', status: 'pass', message: 'The app can search Jira workflows.' });
  } catch (error) {
    checks.push({ key: 'workflows', label: 'Workflow administration', status: 'fail', message: error instanceof Error ? error.message : String(error) });
  }

  if (!projectId) {
    checks.push({ key: 'project', label: 'Target project', status: 'fail', message: 'Choose a target Jira project in Settings.' });
  } else {
    try {
      const projectResponse = await api.asUser().requestJira(route`/rest/api/3/project/${projectId}`, { headers: { Accept: 'application/json' } });
      project = await parseResponse<NonNullable<EnvironmentHealthResult['project']>>(projectResponse);
      checks.push({ key: 'project', label: 'Target project', status: 'pass', message: `${project.name} (${project.key}) is accessible.` });
      checks.push({
        key: 'projectType',
        label: 'Company-managed project',
        status: project.simplified ? 'fail' : 'pass',
        message: project.simplified ? 'Select a company-managed project; team-managed projects do not support these schemes.' : 'The selected project supports Jira schemes.'
      });

      try {
        const countResponse = await api.asUser().requestJira(route`/rest/api/3/search/approximate-count`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ jql: `project = ${project.key}` })
        });
        const countBody = await parseResponse<{ count?: number }>(countResponse);
        issueCount = Number(countBody.count ?? 0);
        checks.push({
          key: 'emptyProject',
          label: 'Empty target project',
          status: issueCount === 0 ? 'pass' : 'warning',
          message: issueCount === 0 ? 'The project is empty and is safe for direct scheme assignment.' : `${issueCount} issue(s) were found. Review workflow migration before changing schemes.`
        });
      } catch (error) {
        checks.push({ key: 'emptyProject', label: 'Empty target project', status: 'warning', message: `Could not verify issue count: ${error instanceof Error ? error.message : String(error)}` });
      }
    } catch (error) {
      checks.push({ key: 'project', label: 'Target project', status: 'fail', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const ready = checks.every((check) => check.status !== 'fail');
  return { checkedAt: new Date().toISOString(), ready, project, issueCount, checks } satisfies EnvironmentHealthResult;
});



// v5.6 JSM migration suite ----------------------------------------------------
type JsmFieldInput = { sourceId?: string; id?: string; name: string; required?: boolean; jiraType?: string; options?: string[] };
type JsmSectionInput = { id: string; name: string; fieldIds: string[] };
type JsmConditionInput = { controllerFieldId: string; operator: string; value: string; targetFieldIds: string[] };

async function findServiceDeskForProject(projectId: string) {
  let start = 0;
  while (start < 500) {
    const response = await api.asUser().requestJira(route`/rest/servicedeskapi/servicedesk?start=${start}&limit=100`, { headers: { Accept: 'application/json' } });
    const body = await parseResponse<{ values?: Array<{ id: string; projectId?: string; projectName?: string }>; isLastPage?: boolean }>(response);
    const values = body.values ?? [];
    const match = values.find((item) => String(item.projectId ?? '') === projectId);
    if (match) return match;
    if (body.isLastPage || values.length === 0) break;
    start += values.length;
  }
  throw new Error('The selected Jira project is not a Jira Service Management service project, or its service desk could not be found.');
}

async function resolveJsmFields(fields: JsmFieldInput[]) {
  const resolution = await resolveScreenFields(fields.map((field) => ({ id: field.id, name: field.name })));
  const byName = new Map(resolution.resolved.map((field) => [normaliseStatusName(field.name), field.id]));
  return fields.map((field) => ({ ...field, jiraFieldId: field.id || byName.get(normaliseStatusName(field.name)) })).filter((field) => field.jiraFieldId);
}


async function ensureIssueTypeAvailableInProject(projectId: string, issueTypeId: string) {
  const schemesResponse = await api.asUser().requestJira(
    route`/rest/api/3/issuetypescheme/project?projectId=${projectId}`,
    { headers: { Accept: 'application/json' } }
  );
  const schemes = await parseResponse<{
    values?: Array<{ issueTypeScheme?: { id?: string; name?: string; isDefault?: boolean }; projectIds?: string[] }>
  }>(schemesResponse);

  const projectScheme = (schemes.values ?? []).find((entry) =>
    (entry.projectIds ?? []).some((id) => String(id) === projectId)
  )?.issueTypeScheme;

  if (!projectScheme?.id) {
    throw new Error('Could not resolve the target project issue type scheme.');
  }

  const mappingsResponse = await api.asUser().requestJira(
    route`/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=${projectScheme.id}`,
    { headers: { Accept: 'application/json' } }
  );
  const mappings = await parseResponse<{
    values?: Array<{ issueTypeSchemeId?: string; issueTypeId?: string }>
  }>(mappingsResponse);

  const alreadyPresent = (mappings.values ?? []).some((entry) =>
    String(entry.issueTypeId ?? '') === issueTypeId
  );

  if (!alreadyPresent) {
    const addResponse = await api.asUser().requestJira(
      route`/rest/api/3/issuetypescheme/${projectScheme.id}/issuetype`,
      {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueTypeIds: [issueTypeId] })
      }
    );
    await parseResponse(addResponse);
  }

  return {
    issueTypeSchemeId: String(projectScheme.id),
    issueTypeSchemeName: String(projectScheme.name ?? ''),
    issueTypeAdded: !alreadyPresent
  };
}

function localUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    const next = value === 'x' ? random : (random & 0x3) | 0x8;
    return next.toString(16);
  });
}

function questionExtension(questionId: string) {
  return {
    type: 'extension',
    attrs: {
      extensionKey: 'question',
      extensionType: 'com.thinktilt.proforma',
      layout: 'default',
      localId: localUuid(),
      parameters: { id: Number(questionId) }
    }
  };
}

function headingNode(name: string) {
  return {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: name }]
  };
}

function collectQuestionExtensions(layout: unknown[]): string[] {
  const ids: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (
      record.type === 'extension' &&
      attrs?.extensionKey === 'question' &&
      attrs?.extensionType === 'com.thinktilt.proforma'
    ) {
      const parameters = attrs.parameters as Record<string, unknown> | undefined;
      if (parameters?.id !== undefined) ids.push(String(parameters.id));
    }
    const content = record.content;
    if (Array.isArray(content)) content.forEach(visit);
  };
  layout.forEach(visit);
  return ids;
}

resolver.define('createJsmRequestType', async ({ payload }) => {
  const projectId = String(payload?.projectId ?? '').trim();
  const issueTypeId = String(payload?.issueTypeId ?? '').trim();
  const name = String(payload?.name ?? '').trim();
  const description = String(payload?.description ?? '').trim();
  if (!projectId || !issueTypeId || !name) throw new Error('Target project, issue type and request type name are required.');

  // A JSM request type is only valid if its underlying Jira issue/work type is
  // available in the target project. Repair the project's existing issue type
  // scheme in-place instead of replacing the entire scheme.
  const issueTypePreparation = await ensureIssueTypeAvailableInProject(projectId, issueTypeId);

  const desk = await findServiceDeskForProject(projectId);
  const listResponse = await api.asUser().requestJira(
    route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true`,
    { headers: { Accept: 'application/json' } }
  );
  const list = await parseResponse<{
    values?: Array<{ id: string; name: string; issueTypeId?: string; groupIds?: string[] }>
  }>(listResponse);

  const sameName = (list.values ?? []).filter(
    (item) => normaliseStatusName(item.name) === normaliseStatusName(name)
  );
  const exact = sameName.find((item) => String(item.issueTypeId ?? '') === issueTypeId);

  if (exact) {
    const duplicates = sameName.filter((item) => String(item.id) !== String(exact.id));
    return {
      status: 'reused',
      serviceDeskId: String(desk.id),
      requestTypeId: String(exact.id),
      name,
      issueTypeId,
      issueTypeSchemeId: issueTypePreparation.issueTypeSchemeId,
      duplicates: duplicates.map((item) => ({ id: String(item.id), issueTypeId: String(item.issueTypeId ?? '') })),
      message:
        `Reused existing request type ${name} (${exact.id}) against Jira work type ${issueTypeId}. ` +
        `${issueTypePreparation.issueTypeAdded ? 'Added the work type to the target project issue type scheme. ' : 'The work type is already available in the target project. '}` +
        `${duplicates.length ? `${duplicates.length} duplicate request type(s) were detected and were not deleted automatically.` : 'No duplicate request types were created.'}`
    };
  }

  // If same-name request types exist but none points at the required issue type,
  // leave them untouched and create a single valid canonical request type.
  const response = await api.asUser().requestJira(route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
    body: JSON.stringify({ name, description, helpText: description, issueTypeId })
  });
  const created = await parseResponse<{ id: string; name?: string; issueTypeId?: string }>(response);
  return {
    status: 'created',
    serviceDeskId: String(desk.id),
    requestTypeId: String(created.id),
    name: created.name || name,
    issueTypeId,
    issueTypeSchemeId: issueTypePreparation.issueTypeSchemeId,
    duplicates: sameName.map((item) => ({ id: String(item.id), issueTypeId: String(item.issueTypeId ?? '') })),
    message:
      `Created JSM request type ${created.name || name} (${created.id}) against Jira work type ${issueTypeId}. ` +
      `${issueTypePreparation.issueTypeAdded ? 'Added the work type to the target project issue type scheme. ' : ''}` +
      `${sameName.length ? `${sameName.length} older same-name request type(s) remain for review; no additional duplicates will be created on rerun.` : ''}`
  };
});

type JsmFormStage = {
  key: 'fieldResolution' | 'baseForm' | 'questions' | 'readback' | 'conditions' | 'publish';
  status: 'created' | 'reused' | 'verified' | 'partial' | 'failed' | 'skipped';
  message: string;
  detail?: unknown;
};

function formQuestionType(jiraType?: string): 'ts' | 'tl' | 'da' | 'cd' | 'us' | 'no' {
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

function apiErrorDetail(error: unknown): unknown {
  const candidate = error as ApiError;
  if (candidate?.body !== undefined) return candidate.body;
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

resolver.define('createJsmForm', async ({ payload }) => {
  const projectId = String(payload?.projectId ?? '').trim();
  const requestTypeId = String(payload?.requestTypeId ?? '').trim();
  const name = String(payload?.name ?? '').trim();
  const fields = Array.isArray(payload?.fields) ? payload.fields as JsmFieldInput[] : [];
  const sections = Array.isArray(payload?.sections) ? payload.sections as JsmSectionInput[] : [];
  const conditions = Array.isArray(payload?.conditions) ? payload.conditions as JsmConditionInput[] : [];
  if (!projectId || !requestTypeId || !name) throw new Error('Target project, request type and form name are required.');

  const stages: JsmFormStage[] = [];
  const resolved = await resolveJsmFields(fields);
  stages.push({
    key: 'fieldResolution',
    status: resolved.length === fields.length ? 'verified' : 'partial',
    message: `Resolved ${resolved.length}/${fields.length} Jira fields for the Form.`
  });

  const desk = await findServiceDeskForProject(projectId);
  const indexResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form`, { headers: { Accept: 'application/json' } });
  const index = await parseResponse<Array<{ id: string; name: string; portalRequestTypeIds?: number[] }>>(indexResponse);
  const existing = index.find((item) => normaliseStatusName(item.name) === normaliseStatusName(name));

  const baseDesign = {
    conditions: {},
    layout: [],
    questions: {},
    sections: {},
    settings: {
      language: 'en',
      name,
      primaryLocale: 'en-US',
      submit: { lock: true, pdf: true }
    }
  };

  let formId = existing?.id ?? '';
  try {
    if (existing) {
      stages.push({ key: 'baseForm', status: 'reused', message: `Reused existing Form template ${name} (${existing.id}).` });
    } else {
      const createResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: baseDesign })
      });
      const created = await parseResponse<{ id?: string; formTemplate?: { id?: string } }>(createResponse);
      formId = String(created.formTemplate?.id || created.id || '');
      if (!formId) throw new Error('Atlassian created the Form template but did not return a Form ID.');
      stages.push({ key: 'baseForm', status: 'created', message: `Created base Form template ${name} (${formId}).` });
    }
  } catch (error) {
    stages.push({ key: 'baseForm', status: 'failed', message: 'Atlassian rejected the base Form template.', detail: apiErrorDetail(error) });
    return {
      status: 'failed', formId, serviceDeskId: String(desk.id), requestTypeId,
      resolvedFields: resolved.length, totalFields: fields.length, sections: sections.length,
      conditions: conditions.length, published: false, stages,
      message: 'Base JSM Form creation failed. See the stage details for the complete Atlassian validation response.'
    };
  }

  // Build real ProForma/Forms ADF layout entries. Merely placing records in the
  // `questions` map is not enough: Jira renders questions from extension nodes
  // inside the design.layout ADF documents.
  const questions: Record<string, unknown> = {};
  const questionIdBySource = new Map<string, string>();
  const questionIdByName = new Map<string, string>();
  let questionNumber = 1;

  for (const field of fields) {
    const match = resolved.find((item) =>
      (field.id && String(item.jiraFieldId) === String(field.id)) ||
      normaliseStatusName(item.name) === normaliseStatusName(field.name)
    );
    if (!match?.jiraFieldId) continue;

    const qid = String(questionNumber++);
    questions[qid] = {
      label: field.name,
      description: '',
      type: formQuestionType(field.jiraType),
      jiraField: String(match.jiraFieldId),
      questionKey: `ivanti-${qid}`,
      validation: { rq: Boolean(field.required) }
    };
    if (field.sourceId) questionIdBySource.set(String(field.sourceId), qid);
    questionIdByName.set(normaliseStatusName(field.name), qid);
  }

  const usedQuestionIds = new Set<string>();
  const layout: unknown[] = [];
  const formSections: Record<string, unknown> = {};

  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    const content: unknown[] = [headingNode(section.name || `Section ${sectionIndex + 1}`)];

    for (const sourceFieldId of section.fieldIds ?? []) {
      const qid = questionIdBySource.get(String(sourceFieldId));
      if (!qid || usedQuestionIds.has(qid)) continue;
      content.push(questionExtension(qid));
      usedQuestionIds.add(qid);
    }

    // Preserve the Ivanti section even if field-to-section metadata was incomplete.
    // The first layout document is the always-visible base area. Subsequent documents
    // are represented as Forms sections so future conditional logic can target them.
    layout.push({ version: 1, type: 'doc', content });
    if (sectionIndex > 0) {
      formSections[String(sectionIndex)] = {
        name: section.name || `Section ${sectionIndex + 1}`,
        sectionType: 'p'
      };
    }
  }

  // Put any questions not referenced by the parser's section metadata into the
  // final visible layout document rather than silently losing them.
  const unplaced = Object.keys(questions).filter((qid) => !usedQuestionIds.has(qid));
  if (unplaced.length) {
    if (!layout.length) layout.push({ version: 1, type: 'doc', content: [] });
    const finalDoc = layout[layout.length - 1] as { content?: unknown[] };
    if (!Array.isArray(finalDoc.content)) finalDoc.content = [];
    unplaced.forEach((qid) => finalDoc.content!.push(questionExtension(qid)));
  }

  const enrichedDesign = {
    conditions: {},
    layout,
    questions,
    sections: formSections,
    settings: baseDesign.settings
  };

  let activeDesign: typeof enrichedDesign | typeof baseDesign = baseDesign;
  try {
    const updateResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ design: enrichedDesign })
    });
    await parseResponse(updateResponse);
    activeDesign = enrichedDesign;
    stages.push({
      key: 'questions',
      status: 'created',
      message: `Saved ${Object.keys(questions).length} linked Jira questions into a real Forms ADF layout across ${layout.length} layout section(s).`
    });
  } catch (error) {
    stages.push({
      key: 'questions', status: 'partial',
      message: 'The base Form exists, but Atlassian rejected the populated question/layout design. The base Form has been preserved.',
      detail: apiErrorDetail(error)
    });
  }

  // Read the template back from Jira and verify the actual stored layout, instead
  // of trusting a successful PUT response.
  let designVerified = false;
  try {
    const getResponse = await api.asUser().requestJira(
      route`/forms/project/${projectId}/form/${formId}`,
      { headers: { Accept: 'application/json' } }
    );
    const stored = await parseResponse<{
      design?: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> }
    }>(getResponse);
    const storedQuestions = Object.keys(stored.design?.questions ?? {});
    const layoutQuestionIds = collectQuestionExtensions(stored.design?.layout ?? []);
    const expectedQuestionIds = Object.keys(questions);
    const missingInQuestionMap = expectedQuestionIds.filter((qid) => !storedQuestions.includes(qid));
    const missingInLayout = expectedQuestionIds.filter((qid) => !layoutQuestionIds.includes(qid));

    designVerified = expectedQuestionIds.length > 0 &&
      missingInQuestionMap.length === 0 &&
      missingInLayout.length === 0;

    stages.push({
      key: 'readback',
      status: designVerified ? 'verified' : 'failed',
      message: designVerified
        ? `Verified Jira stored ${storedQuestions.length} question definition(s) and rendered all ${layoutQuestionIds.length} question extension(s) in the Form layout.`
        : `Jira read-back verification failed: ${missingInQuestionMap.length} question definition(s) and ${missingInLayout.length} layout question(s) are missing.`,
      detail: designVerified ? undefined : {
        expectedQuestions: expectedQuestionIds.length,
        storedQuestions: storedQuestions.length,
        layoutQuestions: layoutQuestionIds.length,
        missingInQuestionMap,
        missingInLayout
      }
    });
  } catch (error) {
    stages.push({
      key: 'readback',
      status: 'failed',
      message: 'Could not read the saved Form template back from Jira for verification.',
      detail: apiErrorDetail(error)
    });
  }

  // Translate inferred Ivanti "equals" rules into supported Forms section
  // conditions. Atlassian's current Forms API accepts advanced conditions with
  // groups/checks and show/hide outputs. We only apply a rule when the
  // controlling question and at least one target section can be resolved.
  let conditionSaveSucceeded = conditions.length === 0;
  if (conditions.length) {
    const advancedConditions: Record<string, unknown> = {};
    const unresolvedRules: Array<{ id?: string; reason: string }> = [];

    for (let conditionIndex = 0; conditionIndex < conditions.length; conditionIndex += 1) {
      const condition = conditions[conditionIndex];
      const controllerQuestionId = questionIdBySource.get(String(condition.controllerFieldId));
      if (!controllerQuestionId) {
        unresolvedRules.push({ id: String((condition as any).id ?? conditionIndex + 1), reason: 'Controller question was not resolved.' });
        continue;
      }

      const targetSourceIds = new Set((condition.targetFieldIds ?? []).map((id) => String(id)));
      const targetSectionIds: string[] = [];

      sections.forEach((section, sectionIndex) => {
        // The first layout document is always visible and is not represented in
        // design.sections. Conditions can only target real section IDs.
        if (sectionIndex === 0) return;
        const intersects = (section.fieldIds ?? []).some((id) => targetSourceIds.has(String(id)));
        if (intersects) targetSectionIds.push(String(sectionIndex));
      });

      if (!targetSectionIds.length) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: 'No target Form section could be resolved from the inferred target fields.'
        });
        continue;
      }

      // Atlassian Forms does not allow EQUAL_TO for ChoiceDropDown
      // questions. Choice-style questions use the set-membership checks
      // (SOME_OF / NONE_OF / ALL_OF), while scalar questions can use
      // EQUAL_TO. Resolve the controller's Forms question type before
      // choosing the comparison.
      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerFormType = formQuestionType(controllerField?.jiraType);
      const comparisonType =
        controllerFormType === 'cd'
          ? 'SOME_OF'
          : 'EQUAL_TO';

      advancedConditions[String(conditionIndex + 1)] = {
        i: {
          // Atlassian Forms currently requires the legacy-compatible `co`
          // object even when the newer advanced operator/groups/checks
          // condition structure is supplied.
          co: {
            cIds: {}
          },
          operator: 'OR',
          groups: [{
            operator: 'AND',
            checks: [{
              fieldId: controllerQuestionId,
              type: comparisonType,
              constraint: [String(condition.value ?? '')]
            }]
          }]
        },
        o: {
          sIds: targetSectionIds,
          t: 'sh'
        }
      };
    }

    if (Object.keys(advancedConditions).length) {
      const conditionedDesign = {
        ...enrichedDesign,
        conditions: advancedConditions
      };
      try {
        const conditionResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
          method: 'PUT',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ design: conditionedDesign })
        });
        await parseResponse(conditionResponse);
        activeDesign = conditionedDesign;
        conditionSaveSucceeded = unresolvedRules.length === 0;
        stages.push({
          key: 'conditions',
          status: unresolvedRules.length ? 'partial' : 'verified',
          message:
            `Applied ${Object.keys(advancedConditions).length}/${conditions.length} inferred Ivanti conditional rule(s) using question-type-aware Forms checks (choice fields use SOME_OF; scalar fields use EQUAL_TO).` +
            (unresolvedRules.length ? ` ${unresolvedRules.length} rule(s) remain for review.` : ''),
          detail: unresolvedRules.length ? { unresolvedRules } : undefined
        });
      } catch (error) {
        stages.push({
          key: 'conditions',
          status: 'partial',
          message: 'The populated Form is valid, but Atlassian rejected the inferred conditional-logic payload. The Form was kept without those conditions.',
          detail: apiErrorDetail(error)
        });
      }
    } else {
      stages.push({
        key: 'conditions',
        status: 'partial',
        message: `None of the ${conditions.length} inferred Ivanti conditional rule(s) could be safely mapped to a Form section.`,
        detail: { unresolvedRules }
      });
    }
  } else {
    stages.push({ key: 'conditions', status: 'verified', message: 'No conditional rules required.' });
  }

  // If conditions were accepted, read them back and verify they persisted.
  if (conditions.length && conditionSaveSucceeded) {
    try {
      const conditionReadbackResponse = await api.asUser().requestJira(
        route`/forms/project/${projectId}/form/${formId}`,
        { headers: { Accept: 'application/json' } }
      );
      const conditionReadback = await parseResponse<{ design?: { conditions?: Record<string, unknown> } }>(conditionReadbackResponse);
      const storedConditionCount = Object.keys(conditionReadback.design?.conditions ?? {}).length;
      if (storedConditionCount < conditions.length) {
        const stage = stages.find((item) => item.key === 'conditions');
        if (stage) {
          stage.status = 'partial';
          stage.message += ` Jira read-back returned ${storedConditionCount}/${conditions.length} condition(s).`;
        }
        conditionSaveSucceeded = false;
      }
    } catch (error) {
      const stage = stages.find((item) => item.key === 'conditions');
      if (stage) {
        stage.status = 'partial';
        stage.message += ' Condition read-back verification failed.';
        stage.detail = apiErrorDetail(error);
      }
      conditionSaveSucceeded = false;
    }
  }

  let published = false;
  if (designVerified) {
    try {
      const publishResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          design: activeDesign,
          publish: {
            jira: {
              issueCreateIssueTypeIds: [],
              issueCreateRequestTypeIds: [Number(requestTypeId)],
              recommendedIssueRequestTypeIds: [],
              submitOnCreate: true,
              validateOnCreate: true
            },
            portal: {
              portalRequestTypeIds: [Number(requestTypeId)],
              submitOnCreate: true,
              validateOnCreate: true
            }
          }
        })
      });
      await parseResponse(publishResponse);
      published = true;
      stages.push({ key: 'publish', status: 'verified', message: `Published verified Form ${name} to request type ${requestTypeId}.` });
    } catch (error) {
      stages.push({ key: 'publish', status: 'failed', message: 'The populated Form was verified, but portal publication failed.', detail: apiErrorDetail(error) });
    }
  } else {
    stages.push({
      key: 'publish',
      status: 'skipped',
      message: 'Publication was skipped because Jira did not verify the expected questions in the stored Form layout.'
    });
  }

  const hasFailure = stages.some((stage) => stage.status === 'failed');
  const hasPartial = stages.some((stage) => stage.status === 'partial' || stage.status === 'skipped');
  const status = hasFailure ? 'partial' : hasPartial ? 'partial' : existing ? 'reused' : 'created';
  return {
    status, formId, serviceDeskId: String(desk.id), requestTypeId,
    resolvedFields: resolved.length, totalFields: fields.length, sections: sections.length,
    conditions: conditions.length, published, stages,
    message: published
      ? `JSM Form ${name} was populated, read back from Jira, verified and published.`
      : `JSM Form ${name} exists, but read-back verification or publication requires review.`
  };
});

resolver.define('verifyJsmPortal', async ({ payload }) => {
  const projectId = String(payload?.projectId ?? '').trim();
  const requestTypeId = String(payload?.requestTypeId ?? '').trim();
  const expectedIssueTypeId = String(payload?.issueTypeId ?? '').trim();
  if (!projectId || !requestTypeId) throw new Error('Target project and request type are required.');

  const desk = await findServiceDeskForProject(projectId);
  const requestResponse = await api.asUser().requestJira(
    route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype/${requestTypeId}`,
    { headers: { Accept: 'application/json' } }
  );
  const requestType = await parseResponse<{
    id: string;
    name: string;
    issueTypeId?: string;
    groupIds?: string[];
  }>(requestResponse);

  let formAttached = false;
  let formId = '';
  try {
    const formResponse = await api.asUser().requestJira(
      route`/forms/servicedesk/${desk.id}/requesttype/${requestTypeId}/form`,
      { headers: { Accept: 'application/json' } }
    );
    const form = await parseResponse<{ id?: string }>(formResponse);
    formAttached = Boolean(form?.id);
    formId = String(form?.id || '');
  } catch (error) {
    if ((error as ApiError)?.status !== 404) throw error;
  }

  let portalGroups: Array<{ id: string; name: string }> = [];
  try {
    const groupsResponse = await api.asUser().requestJira(
      route`/rest/servicedeskapi/servicedesk/${desk.id}/requesttypegroup`,
      { headers: { Accept: 'application/json' } }
    );
    const groups = await parseResponse<{ values?: Array<{ id?: string; name?: string }> }>(groupsResponse);
    portalGroups = (groups.values ?? [])
      .filter((group) => group.id && group.name)
      .map((group) => ({ id: String(group.id), name: String(group.name) }));
  } catch {
    // Group discovery is helpful but must not break final verification.
  }

  const issueTypeMatches = !expectedIssueTypeId ||
    String(requestType.issueTypeId ?? '') === expectedIssueTypeId;
  const visibleInPortal = Boolean(requestType.groupIds?.length);
  const fullyConnected = formAttached && issueTypeMatches;
  const status = fullyConnected && visibleInPortal ? 'verified' : 'partial';

  let message = `Request type ${requestType.name} exists`;
  message += issueTypeMatches
    ? ` and is linked to Jira work type ${requestType.issueTypeId || expectedIssueTypeId}.`
    : ` but is linked to Jira work type ${requestType.issueTypeId || 'unknown'} instead of ${expectedIssueTypeId}.`;
  message += formAttached
    ? ` Its published JSM Form is attached${formId ? ` (${formId})` : ''}.`
    : ' No published portal Form was returned.';
  if (visibleInPortal) {
    message += ` The request type belongs to portal group ID(s): ${(requestType.groupIds ?? []).join(', ')}.`;
  } else {
    message += ' The request type is hidden because it has no portal group. Atlassian’s public create-request-type API leaves groups empty; assign it to a portal group in Project settings.';
    if (portalGroups.length) message += ` Available portal groups: ${portalGroups.map((group) => group.name).join(', ')}.`;
  }

  return {
    status,
    serviceDeskId: String(desk.id),
    requestTypeId,
    requestTypeName: requestType.name,
    issueTypeId: String(requestType.issueTypeId ?? ''),
    issueTypeMatches,
    formAttached,
    formId,
    visibleInPortal,
    groupIds: requestType.groupIds ?? [],
    portalGroups,
    message
  };
});

resolver.define('deleteDuplicateJsmRequestTypes', async ({ payload }) => {
  const serviceDeskId = String(payload?.serviceDeskId ?? '').trim();
  const keepRequestTypeId = String(payload?.keepRequestTypeId ?? '').trim();
  const duplicateIds = Array.isArray(payload?.duplicateIds)
    ? payload.duplicateIds.map((id: unknown) => String(id).trim()).filter(Boolean)
    : [];

  if (!serviceDeskId || !keepRequestTypeId) throw new Error('Service desk and canonical request type are required.');

  const safeIds: string[] = [...new Set<string>(duplicateIds as string[])].filter((id: string) => id !== keepRequestTypeId);
  const results: Array<{ id: string; status: 'deleted' | 'failed'; message: string }> = [];

  for (const id of safeIds) {
    try {
      const response = await api.asUser().requestJira(
        route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype/${id}`,
        {
          method: 'DELETE',
          headers: { Accept: 'application/json', 'X-ExperimentalApi': 'opt-in' }
        }
      );
      if (!response.ok && response.status !== 204) await parseResponse(response);
      results.push({ id: String(id), status: 'deleted', message: `Deleted duplicate request type ${id}.` });
    } catch (error) {
      const detail = apiErrorDetail(error);
      const message = typeof detail === 'string' ? detail : JSON.stringify(detail ?? (error instanceof Error ? error.message : String(error)));
      results.push({ id: String(id), status: 'failed', message });
    }
  }

  const deleted = results.filter((item) => item.status === 'deleted').length;
  return {
    status: results.some((item) => item.status === 'failed') ? 'partial' : 'deleted',
    deleted,
    failed: results.length - deleted,
    results,
    message: `${deleted} duplicate request type(s) deleted; ${results.length - deleted} failed.`
  };
});


type WorkflowMigrationStatusInput = {
  name: string;
  statusCategory?: 'TODO' | 'IN_PROGRESS' | 'DONE';
};

type WorkflowMigrationTransitionInput = {
  name: string;
  fromStatus?: string;
  toStatus?: string;
  condition?: string;
  assignment?: string;
};

type WorkflowMigrationRequest = {
  serviceName: string;
  description?: string;
  statuses: WorkflowMigrationStatusInput[];
  transitions: WorkflowMigrationTransitionInput[];
};

function workflowEnginePayload(request: WorkflowMigrationRequest, jiraStatuses: JiraStatus[]) {
  const statusNames = [...new Set(
    (request.statuses ?? []).map((status) => String(status.name ?? '').trim()).filter(Boolean)
  )];

  if (statusNames.length < 2) {
    throw new Error('At least two explicit workflow statuses are required.');
  }

  const existingByName = new Map(
    jiraStatuses
      .filter((status) => normaliseStatusName(status?.name))
      .map((status) => [normaliseStatusName(status.name), status])
  );
  const refs = new Map<string, string>();
  statusNames.forEach((name) => refs.set(normaliseStatusName(name), crypto.randomUUID()));

  const categoryByName = new Map(
    (request.statuses ?? []).map((status) => [
      normaliseStatusName(status.name),
      status.statusCategory || 'IN_PROGRESS'
    ])
  );

  const resolvedStatuses = statusNames.map((name, index) => {
    const existing = existingByName.get(normaliseStatusName(name));
    const category = categoryByName.get(normaliseStatusName(name)) ||
      statusCategory(index, statusNames.length);
    return existing
      ? {
          id: existing.id,
          description: existing.description || `Reused by Ivanti Workflow Migration Engine for ${request.serviceName}.`,
          name: existing.name,
          statusCategory: existingStatusCategory(existing, index, statusNames.length),
          statusReference: refs.get(normaliseStatusName(name))
        }
      : {
          description: `Created by Ivanti Workflow Migration Engine for ${request.serviceName}.`,
          name,
          statusCategory: category,
          statusReference: refs.get(normaliseStatusName(name))
        };
  });

  const directed = (request.transitions ?? []).flatMap((transition, index) => {
    const from = refs.get(normaliseStatusName(transition.fromStatus));
    const to = refs.get(normaliseStatusName(transition.toStatus));
    if (!from || !to) return [];
    return [{
      actions: [],
      description: transition.condition
        ? `Ivanti condition for review: ${transition.condition}`
        : `Migrated Ivanti transition ${transition.name}.`,
      id: String(20 + (index * 10)),
      links: [{ fromPort: 0, fromStatusReference: from, toPort: 1 }],
      name: String(transition.name || `${transition.fromStatus} → ${transition.toStatus}`).slice(0, 120),
      properties: {},
      toStatusReference: to,
      triggers: [],
      type: 'DIRECTED',
      validators: []
    }];
  });

  if (!directed.length) {
    throw new Error('No buildable Ivanti transitions with both source and target statuses were supplied.');
  }

  const firstStatus = statusNames[0];
  const firstRef = refs.get(normaliseStatusName(firstStatus));
  const workflowName = `${request.serviceName} - Ivanti Workflow v6`;

  return {
    workflowName,
    payload: {
      scope: { type: 'GLOBAL' },
      statuses: resolvedStatuses,
      workflows: [{
        description: request.description || `Workflow migrated from Ivanti for ${request.serviceName}.`,
        name: workflowName,
        startPointLayout: { x: -100, y: -120 },
        statuses: statusNames.map((name, index) => ({
          layout: { x: 120 + ((index % 4) * 230), y: 40 + (Math.floor(index / 4) * 180) },
          properties: {},
          statusReference: refs.get(normaliseStatusName(name))
        })),
        transitions: [
          {
            actions: [],
            description: 'Initial transition created by Ivanti Workflow Migration Engine.',
            id: '1',
            links: [],
            name: 'Create',
            properties: {},
            toStatusReference: firstRef,
            triggers: [],
            type: 'INITIAL',
            validators: []
          },
          ...directed
        ]
      }]
    },
    statusCount: statusNames.length,
    transitionCount: directed.length
  };
}

resolver.define('validateIvantiWorkflow', async ({ payload }) => {
  const request = payload as WorkflowMigrationRequest;
  if (!request?.serviceName) throw new Error('Service name is required.');

  const jiraStatuses = await getAllStatuses();
  const prepared = workflowEnginePayload(request, jiraStatuses);
  const response = await api.asUser().requestJira(route`/rest/api/3/workflows/create/validation`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: prepared.payload,
      validationOptions: { levels: ['ERROR', 'WARNING'] }
    })
  });
  const validation = await parseResponse<unknown>(response);

  return {
    mode: 'validate',
    status: 'verified',
    workflowName: prepared.workflowName,
    statusCount: prepared.statusCount,
    transitionCount: prepared.transitionCount,
    validation,
    message: `Jira accepted the proposed workflow payload for validation: ${prepared.statusCount} statuses and ${prepared.transitionCount} directed transitions. No Jira configuration was changed.`
  };
});

resolver.define('createIvantiWorkflow', async ({ payload }) => {
  const request = payload as WorkflowMigrationRequest;
  if (!request?.serviceName) throw new Error('Service name is required.');

  const jiraStatuses = await getAllStatuses();
  const prepared = workflowEnginePayload(request, jiraStatuses);
  const existing = await findWorkflowByName(prepared.workflowName);

  if (existing?.id) {
    return {
      mode: 'create',
      status: 'reused',
      workflowId: existing.id,
      workflowName: prepared.workflowName,
      statusCount: prepared.statusCount,
      transitionCount: prepared.transitionCount,
      message: `Reused existing versioned workflow ${prepared.workflowName}. The engine never overwrites a live workflow silently.`
    };
  }

  const validationResponse = await api.asUser().requestJira(route`/rest/api/3/workflows/create/validation`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payload: prepared.payload,
      validationOptions: { levels: ['ERROR', 'WARNING'] }
    })
  });
  await parseResponse<unknown>(validationResponse);

  const createResponse = await api.asUser().requestJira(route`/rest/api/3/workflows/create`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(prepared.payload)
  });
  const created = await parseResponse<{ workflows?: Array<{ id?: string; name?: string }> }>(createResponse);
  const workflow = created.workflows?.[0];

  return {
    mode: 'create',
    status: 'created',
    workflowId: workflow?.id,
    workflowName: workflow?.name || prepared.workflowName,
    statusCount: prepared.statusCount,
    transitionCount: prepared.transitionCount,
    message: `Created versioned Jira workflow ${workflow?.name || prepared.workflowName} after successful Jira validation. Approvals, notifications and ambiguous Ivanti conditions remain explicitly flagged for review rather than being guessed.`
  };
});

export const handler = resolver.getDefinitions();
