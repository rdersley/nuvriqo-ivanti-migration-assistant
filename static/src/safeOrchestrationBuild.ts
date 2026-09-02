import { invoke } from '@forge/bridge';

const STORAGE_KEY = 'ivanti-migration-assistant-project-v3';
const ISSUE_TYPE_KEY = 'ivanti-orchestration-issue-type-v1';
let busy = false;

function text(el: Element | null | undefined): string {
  return (el?.textContent || '').replace(/\s+/g, ' ').trim();
}

function project(): any | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}

function serviceFromScreen(): any | null {
  const selected = Array.from(document.querySelectorAll('h1,h2,h3')).find(el => {
    const value = text(el);
    return value && !['Create service configuration', 'Retail inMotion Ivanti migration'].includes(value);
  });
  const serviceName = text(selected);
  if (!serviceName) return null;
  const description = text(selected?.parentElement?.querySelector('p')) || `Migrated from Ivanti: ${serviceName}`;
  return {
    analysis: { serviceName, description, fields: [] },
    build: { fieldResults: [] },
    formSections: [],
    proposedConditions: []
  };
}

function activeService(): any | null {
  const p = project();
  if (p?.services?.length) return p.services[0];
  return serviceFromScreen();
}

function savedIssueType(): { id: string; name?: string } | null {
  try { return JSON.parse(sessionStorage.getItem(ISSUE_TYPE_KEY) || 'null'); } catch { return null; }
}

function saveIssueType(id: string, name?: string) {
  sessionStorage.setItem(ISSUE_TYPE_KEY, JSON.stringify({ id, name }));
}

function resultBox(message: string, ok = true) {
  let box = document.querySelector('.safeOrchestrationBuildResult') as HTMLElement | null;
  if (!box) {
    box = document.createElement('div');
    box.className = 'safeOrchestrationBuildResult';
    box.style.cssText = 'margin:16px 0;padding:14px 16px;border-radius:8px;font-weight:600;';
    const heading = Array.from(document.querySelectorAll('h2')).find(h => text(h) === 'Create service configuration');
    heading?.parentElement?.insertBefore(box, heading.nextSibling);
  }
  box.style.background = ok ? '#dcfff1' : '#ffebe6';
  box.style.color = ok ? '#164b35' : '#ae2a19';
  box.textContent = message;
}

function prepareConditionalSections(rawSections: any[], rawConditions: any[]) {
  const sections = Array.isArray(rawSections) ? rawSections : [];
  const conditions = Array.isArray(rawConditions) ? rawConditions : [];
  if (!conditions.length) return sections;

  const targetIds = new Set<string>();
  conditions.forEach((condition: any) => {
    (condition?.targetFieldIds || []).forEach((id: any) => targetIds.add(String(id)));
  });

  const prepared: any[] = [];
  const placedConditional = new Set<string>();

  sections.forEach((section: any, sectionIndex: number) => {
    const ids = Array.isArray(section?.fieldIds) ? section.fieldIds.map((id: any) => String(id)) : [];
    const baseIds = ids.filter((id: string) => !targetIds.has(id));

    if (baseIds.length || sectionIndex === 0) {
      prepared.push({
        ...section,
        id: String(section?.id || `section-${sectionIndex + 1}`),
        fieldIds: baseIds
      });
    }

    conditions.forEach((condition: any, conditionIndex: number) => {
      const conditionTargets = new Set((condition?.targetFieldIds || []).map((id: any) => String(id)));
      const matches = ids.filter((id: string) => conditionTargets.has(id));
      if (!matches.length) return;
      matches.forEach((id: string) => placedConditional.add(id));
      prepared.push({
        id: `conditional-${conditionIndex + 1}-${sectionIndex + 1}`,
        name: `${section?.name || `Section ${sectionIndex + 1}`} — conditional`,
        fieldIds: matches
      });
    });
  });

  conditions.forEach((condition: any, conditionIndex: number) => {
    const missing = (condition?.targetFieldIds || [])
      .map((id: any) => String(id))
      .filter((id: string) => !placedConditional.has(id));
    if (missing.length) {
      prepared.push({
        id: `conditional-${conditionIndex + 1}-unplaced`,
        name: `Conditional fields ${conditionIndex + 1}`,
        fieldIds: missing
      });
    }
  });

  return prepared;
}

function conditionStage(form: any): any | undefined {
  return Array.isArray(form?.stages) ? form.stages.find((stage: any) => stage?.key === 'conditions') : undefined;
}

async function createIssueTypeOnly(button: HTMLButtonElement) {
  if (busy) return;
  const service = activeService();
  if (!service?.analysis?.serviceName) return resultBox('Could not determine the selected imported service. Refresh the page and try again.', false);
  busy = true;
  button.disabled = true;
  button.textContent = 'Creating issue type…';
  try {
    const result: any = await invoke('createJiraStructure', {
      serviceName: service.analysis.serviceName,
      description: service.analysis.description,
      statuses: [],
      createIssueType: true,
      createWorkflow: false,
      createWorkflowScheme: false
    });
    if (!result?.issueTypeId) throw new Error(result?.message || 'Jira did not return an issue type ID.');
    saveIssueType(String(result.issueTypeId), service.analysis.serviceName);
    resultBox(`Issue type ready (${result.issueTypeId}). JSM experience is now unlocked.`);
  } catch (error) {
    resultBox(`Issue type build failed: ${error instanceof Error ? error.message : String(error)}`, false);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Create/reuse issue type';
    apply();
  }
}

async function buildJsm(button: HTMLButtonElement) {
  if (busy) return;
  const p = project();
  const service = p?.services?.[0];
  const issue = savedIssueType();
  if (!p?.targetProjectId || !service || !issue?.id) return resultBox('Save the migration project first, then retry Build JSM experience.', false);
  busy = true;
  button.disabled = true;
  button.textContent = 'Building JSM…';
  try {
    const request: any = await invoke('createJsmRequestType', {
      projectId: p.targetProjectId,
      issueTypeId: issue.id,
      name: service.analysis.serviceName,
      description: service.analysis.description || `Migrated from Ivanti: ${service.analysis.serviceName}`
    });

    const resultByName = new Map((service.build?.fieldResults || []).filter((f: any) => f.id).map((f: any) => [String(f.name).trim().toLowerCase(), f]));
    const fields = (service.analysis.fields || []).map((field: any) => ({
      sourceId: field.id,
      id: (resultByName.get(String(field.name).trim().toLowerCase()) as any)?.id,
      name: field.name,
      required: field.required,
      jiraType: field.jiraType,
      options: field.options
    }));

    const conditions = service.proposedConditions || [];
    const sections = prepareConditionalSections(service.formSections || [], conditions);

    const form: any = await invoke('createJsmForm', {
      projectId: p.targetProjectId,
      requestTypeId: request.requestTypeId,
      name: `${service.analysis.serviceName} - Ivanti Migration Form`,
      fields,
      sections,
      conditions
    });
    if (!form?.published) throw new Error(form?.message || 'The JSM Form was not published.');

    const condition = conditionStage(form);
    if (conditions.length && (!condition || condition.status !== 'verified')) {
      const reason = condition?.message || 'Jira did not verify the conditional logic stage.';
      throw new Error(`Form published, but conditional logic is not verified: ${reason}`);
    }

    const portal: any = await invoke('verifyJsmPortal', {
      projectId: p.targetProjectId,
      requestTypeId: request.requestTypeId,
      issueTypeId: issue.id
    });
    resultBox(`JSM build complete. Request type ${request.requestTypeId}; Form ${form.formId || 'created'}; ${conditions.length} conditional rule(s) verified; portal ${portal?.visibleInPortal ? 'verified' : 'requires portal-group review'}.`);
  } catch (error) {
    resultBox(`JSM build failed: ${error instanceof Error ? error.message : String(error)}`, false);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Build JSM experience';
  }
}

function apply() {
  const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
  const structure = buttons.find(b => ['Create Jira structure', 'Create/reuse issue type', 'Creating issue type…'].includes(text(b)));
  if (structure && !structure.dataset.safeOrchestration) {
    structure.dataset.safeOrchestration = 'true';
    structure.textContent = 'Create/reuse issue type';
    const card = structure.closest('article');
    const strong = card?.querySelector('strong');
    const p = card?.querySelector('p');
    if (strong) strong.textContent = 'Jira issue type';
    if (p) p.textContent = 'Create or reuse only the Jira issue type required by the JSM request type and Form. Workflow creation stays separate.';
    structure.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      void createIssueTypeOnly(structure);
    }, true);
  }

  const jsm = buttons.find(b => ['Build JSM experience', 'Building JSM…'].includes(text(b)));
  if (jsm && savedIssueType()?.id) {
    jsm.disabled = false;
    if (!jsm.dataset.safeOrchestration) {
      jsm.dataset.safeOrchestration = 'true';
      jsm.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
        void buildJsm(jsm);
      }, true);
    }
  }
}

const observer = new MutationObserver(apply);
observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
window.setTimeout(apply, 0);
