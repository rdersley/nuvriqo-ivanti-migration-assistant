import api, { route } from '@forge/api';

type ForgeResponse = { ok: boolean; status: number; statusText: string; text(): Promise<string> };
type JiraField = { id: string; name: string; schema?: { custom?: string } };
type FormIndex = { id: string | number; name?: string; portalRequestTypeIds?: number[] };
type FormDesign = {
  questions?: Record<string, any>;
  layout?: any[];
  sections?: Record<string, any>;
  conditions?: Record<string, any>;
  settings?: Record<string, any>;
};
type StoredForm = { id?: string | number; name?: string; publish?: any; design?: FormDesign };

async function parseResponse<T>(response: ForgeResponse): Promise<T> {
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : {}; } catch { /* preserve text */ }
  if (!response.ok) {
    const message = body?.errorMessages?.join?.('; ') || body?.message || body?.detail || text || `${response.status} ${response.statusText}`;
    throw new Error(`${response.status}: ${message}`);
  }
  return body as T;
}

function normalise(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function serviceBaseName(value: unknown) {
  return normalise(value).replace(/ ivanti migration form$/, '').trim();
}

const HIDDEN_HELPER_NAMES = new Set([
  'dept manager display name',
  'department manager display name',
  'facility detail',
  'new employee information',
  'equipment details',
  'imagefield',
  'image field'
]);

function removeQuestionFromLayout(nodes: any[], questionId: string): any[] {
  const visit = (node: any): any | null => {
    if (!node || typeof node !== 'object') return node;
    const attrs = node.attrs;
    if (node.type === 'extension' && attrs?.extensionKey === 'question' && String(attrs?.parameters?.id ?? '') === String(questionId)) return null;
    if (Array.isArray(node.content)) node = { ...node, content: node.content.map(visit).filter((item: any) => item !== null) };
    return node;
  };
  return nodes.map(visit).filter((item) => item !== null);
}

async function ensureTextField(catalogue: JiraField[], label: string): Promise<JiraField> {
  const repairName = `${label} - Ivanti Text`;
  const existing = catalogue.find((field) => normalise(field.name) === normalise(repairName) && String(field.schema?.custom ?? '').includes('customfieldtypes:textfield'));
  if (existing) return existing;

  const response = await api.asUser().requestJira(route`/rest/api/3/field`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: repairName,
      description: `Text field created by Ivanti Migration Assistant to preserve the original Ivanti lookup value for ${label}.`,
      type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
      searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'
    })
  });
  const created = await parseResponse<JiraField>(response);
  catalogue.push(created);
  return created;
}

function matchesWantedForm(formName: unknown, wanted: Set<string>) {
  const exact = normalise(formName);
  const base = serviceBaseName(formName);
  return wanted.has(exact) || wanted.has(base);
}

export async function repairMigratedForms(projectId: string, serviceNames: string[]) {
  if (!projectId) throw new Error('Target Jira project is required.');
  const wanted = new Set(serviceNames.flatMap((name) => [normalise(name), serviceBaseName(name)]).filter(Boolean));
  if (!wanted.size) throw new Error('No migrated services were supplied for form repair.');

  const fieldsResponse = await api.asUser().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  const catalogue = await parseResponse<JiraField[]>(fieldsResponse);
  const indexResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form`, { headers: { Accept: 'application/json' } });
  const forms = await parseResponse<FormIndex[]>(indexResponse);

  // The Forms index can expose a generated migration suffix, while the stored design carries
  // the authoritative name. Fetch candidates and match both so an already-created form is repaired in place.
  const candidates: Array<{ index: FormIndex; stored: StoredForm }> = [];
  for (const form of forms) {
    const getResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${form.id}`, { headers: { Accept: 'application/json' } });
    const stored = await parseResponse<StoredForm>(getResponse);
    const storedName = stored.design?.settings?.name ?? stored.name ?? form.name ?? '';
    if (matchesWantedForm(storedName, wanted) || matchesWantedForm(form.name, wanted)) candidates.push({ index: form, stored });
  }

  const results: Array<{ formId: string; name: string; repairedLookups: string[]; hiddenHelpers: string[]; changed: boolean }> = [];

  for (const { index: form, stored } of candidates) {
    const design: FormDesign = JSON.parse(JSON.stringify(stored.design ?? {}));
    const questions = design.questions ?? {};
    let layout = Array.isArray(design.layout) ? design.layout : [];
    const repairedLookups: string[] = [];
    const hiddenHelpers: string[] = [];

    for (const [questionId, question] of Object.entries(questions)) {
      const label = String(question?.label ?? '').trim();
      const key = normalise(label);
      if (HIDDEN_HELPER_NAMES.has(key)) {
        delete questions[questionId];
        layout = removeQuestionFromLayout(layout, questionId);
        hiddenHelpers.push(label);
        continue;
      }

      if (key === 'hiring manager' || key === 'department manager') {
        const currentType = String(question?.type ?? '');
        const jiraField = catalogue.find((field) => String(field.id) === String(question?.jiraField ?? ''));
        const customType = String(jiraField?.schema?.custom ?? '');
        if (currentType !== 'ts' || !customType.includes('customfieldtypes:textfield')) {
          const textField = await ensureTextField(catalogue, label);
          questions[questionId] = { ...question, type: 'ts', jiraField: String(textField.id) };
          repairedLookups.push(label);
        }
      }
    }

    const changed = repairedLookups.length > 0 || hiddenHelpers.length > 0;
    const displayName = String(design.settings?.name ?? stored.name ?? form.name ?? form.id);
    if (changed) {
      design.questions = questions;
      design.layout = layout;
      // Preserve the exact live publish object. Its Jira property names differ from older migration code.
      const body: any = { design };
      if (stored.publish) body.publish = stored.publish;
      const putResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${form.id}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
        body: JSON.stringify(body)
      });
      await parseResponse(putResponse);
    }

    results.push({ formId: String(form.id), name: displayName, repairedLookups, hiddenHelpers, changed });
  }

  return { projectId, matchedForms: candidates.length, changedForms: results.filter((item) => item.changed).length, results };
}
