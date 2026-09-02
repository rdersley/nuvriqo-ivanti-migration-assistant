import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@forge/bridge';
import { parseIvantiXml } from './xmlParser';
import type {
  Analysis,
  AutomationBlueprintRule,
  BuildPlan,
  CreationResult,
  FormSection,
  JiraFieldType,
  MigrationProject,
  MigrationService,
  PreflightConflict,
  Project,
  ProposedCondition,
  ServiceImplementationBlueprint,
  WorkflowCategory,
  WorkflowMigrationResult,
  AutomationCandidate,
  AutomationMigrationPack,
  BuildLogEntry,
  BuildCheckpoint,
  ExistingFieldComparison,
  IntelligentFieldMapping,
  MappingAction,
  JiraStructureResult,
  ProjectActivationResult,
  EnvironmentHealthResult,
  ScreenStructureResult,
  ScreenActivationResult,
  JsmRequestTypeResult,
  JsmFormResult,
  JsmPortalResult,
  JsmDuplicateCleanupResult
} from './types';

const TYPE_OPTIONS: Array<[JiraFieldType, string]> = [
  ['text', 'Text (single line)'],
  ['paragraph', 'Paragraph'],
  ['date', 'Date'],
  ['select', 'Select list'],
  ['checkbox', 'Yes/No (single select)'],
  ['user', 'User picker'],
  ['number', 'Number']
];

type MainView = 'dashboard' | 'services' | 'shared-fields' | 'build' | 'orchestrator' | 'report' | 'validation' | 'health' | 'settings';
type ServiceView = 'overview' | 'fields' | 'form' | 'workflow' | 'automation' | 'validation' | 'create';

const STORAGE_KEY = 'ivanti-migration-assistant-project-v3';
const CHECKPOINT_KEY = 'ivanti-migration-assistant-build-checkpoint-v1';

const CATEGORY_LABELS: Record<WorkflowCategory, string> = {
  task: 'Task',
  approval: 'Approval',
  condition: 'Condition',
  notification: 'Notification',
  transition: 'Transition',
  activity: 'Activity'
};

function nowIso() {
  return new Date().toISOString();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function serviceId(name: string, sourceFile: string): string {
  return `${slug(name)}-${slug(sourceFile)}-${Date.now()}`;
}

function includesAny(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function proposeFormSections(analysis: Analysis): FormSection[] {
  const definitions = [
    { name: 'Employee details', terms: ['first name', 'last name', 'title', 'start date', 'employment', 'department', 'location', 'facility', 'manager'] },
    { name: 'Computer equipment', terms: ['computer', 'docking', 'monitor', 'keyboard', 'mouse', 'test device', 'port replicator'] },
    { name: 'Mobile phone', terms: ['mobile phone', 'cellular', 'phone type'] },
    { name: 'Shipping details', terms: ['shipping', 'private email', 'phone number', 'address'] },
    { name: 'Access and additional information', terms: ['service desk', 'servicedesk', 'additional', 'special request'] }
  ];

  const assigned = new Set<string>();
  const sections = definitions.map((definition) => {
    const fieldIds = analysis.fields
      .filter((field) => includesAny(field.ivantiName, definition.terms))
      .map((field) => {
        assigned.add(field.id);
        return field.id;
      });
    return { id: slug(definition.name), name: definition.name, fieldIds };
  }).filter((section) => section.fieldIds.length);

  const remaining = analysis.fields.filter((field) => !assigned.has(field.id)).map((field) => field.id);
  if (remaining.length) sections.push({ id: 'other-details', name: 'Other details', fieldIds: remaining });
  return sections;
}

function findField(analysis: Analysis, names: string[]) {
  return analysis.fields.find((field) => {
    const lower = field.ivantiName.toLowerCase().replace(/\?/g, '').trim();
    return names.some((name) => lower === name || lower.includes(name));
  });
}

function proposeConditions(analysis: Analysis): ProposedCondition[] {
  const proposals: ProposedCondition[] = [];
  const add = (controllerNames: string[], targetTerms: string[]) => {
    const controller = findField(analysis, controllerNames);
    if (!controller) return;
    const targetFieldIds = analysis.fields
      .filter((field) => field.id !== controller.id && includesAny(field.ivantiName, targetTerms))
      .map((field) => field.id);
    if (!targetFieldIds.length) return;
    proposals.push({
      id: `${controller.id}-yes`,
      controllerFieldId: controller.id,
      operator: 'equals',
      value: 'Yes',
      targetFieldIds,
      source: 'inferred'
    });
  };

  add(['computer required'], ['computer type', 'docking', 'monitor', 'keyboard', 'mouse', 'test device', 'port replicator']);
  add(['secondary monitor requested', 'second monitor requested'], ['secondary monitor']);
  add(['mobile phone required'], ['mobile phone type', 'mobile phone']);
  add(['equipment shipping required', 'shipping required'], ['private email', 'phone number', 'shipping address', 'employee address']);
  return proposals;
}

function newProject(): MigrationProject {
  const timestamp = nowIso();
  return {
    schemaVersion: 2,
    name: 'Retail inMotion Ivanti migration',
    targetProjectId: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    services: []
  };
}

function serviceReadiness(service: MigrationService): number {
  let score = 20;
  if (service.analysis.fields.length) score += 25;
  if (service.formSections.length) score += 20;
  if (service.proposedConditions.length) score += 10;
  if (service.build.fieldResults.some((result) => ['created', 'reused'].includes(result.status))) score += 15;
  if (service.analysis.workflowItems.length || service.analysis.suggestedWorkflow.statuses.length) score += 10;
  return Math.min(score, 100);
}

function qualityLabel(score: number): { label: string; tone: string } {
  if (score >= 90) return { label: 'Excellent migration candidate', tone: 'excellent' };
  if (score >= 80) return { label: 'Ready for build review', tone: 'good' };
  if (score >= 65) return { label: 'Needs review', tone: 'review' };
  return { label: 'Missing information', tone: 'poor' };
}

function automationBlueprint(service: MigrationService): AutomationBlueprintRule[] {
  const rules: AutomationBlueprintRule[] = [];
  const tasks = service.analysis.suggestedWorkflow.taskNames;

  rules.push({
    name: `${service.analysis.serviceName} — initialise request`,
    trigger: 'Work item created',
    conditions: [`Request type equals "${service.analysis.serviceName}"`],
    actions: ['Transition parent request to Provisioning', 'Add migration label']
  });

  if (tasks.length) {
    rules.push({
      name: `${service.analysis.serviceName} — create fulfilment tasks`,
      trigger: 'Parent enters Provisioning',
      conditions: [`Request type equals "${service.analysis.serviceName}"`],
      actions: tasks.map((task) => `Create subtask: ${task}`)
    });
  }

  service.proposedConditions.forEach((condition) => {
    const controller = service.analysis.fields.find((field) => field.id === condition.controllerFieldId);
    const targets = condition.targetFieldIds
      .map((id) => service.analysis.fields.find((field) => field.id === id)?.name)
      .filter(Boolean);
    if (!controller || !targets.length) return;
    rules.push({
      name: `${service.analysis.serviceName} — ${controller.name} condition`,
      trigger: 'Request created or updated',
      conditions: [`${controller.name} equals ${condition.value}`],
      actions: [`Use values for: ${targets.join(', ')}`]
    });
  });

  rules.push({
    name: `${service.analysis.serviceName} — complete parent`,
    trigger: 'Subtask transitioned to Done',
    conditions: ['All sibling subtasks are in Done status category'],
    actions: ['Transition parent request to Completed']
  });

  return rules;
}

function implementationBlueprint(service: MigrationService): ServiceImplementationBlueprint {
  return {
    serviceId: service.id,
    serviceName: service.analysis.serviceName,
    sourceFile: service.sourceFile,
    requestType: {
      name: service.analysis.serviceName,
      description: service.analysis.description,
      proposedPortalGroup: 'IT Services'
    },
    form: {
      sections: service.formSections,
      conditions: service.proposedConditions
    },
    workflow: service.analysis.suggestedWorkflow,
    automation: automationBlueprint(service)
  };
}

export default function App() {
  const [jiraProjects, setJiraProjects] = useState<Project[]>([]);
  const [migration, setMigration] = useState<MigrationProject>(() => newProject());
  const [activeServiceId, setActiveServiceId] = useState('');
  const [mainView, setMainView] = useState<MainView>('dashboard');
  const [serviceView, setServiceView] = useState<ServiceView>('overview');
  const [workflowFilter, setWorkflowFilter] = useState<'all' | WorkflowCategory>('all');
  const [workflowEngineBusy, setWorkflowEngineBusy] = useState(false);
  const [workflowEngineResults, setWorkflowEngineResults] = useState<Record<string, WorkflowMigrationResult>>({});
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [orchestrationRunning, setOrchestrationRunning] = useState(false);
  const [orchestrationStep, setOrchestrationStep] = useState(0);
  const [buildLogs, setBuildLogs] = useState<BuildLogEntry[]>([]);
  const [checkpoint, setCheckpoint] = useState<BuildCheckpoint | null>(null);
  const [existingComparison, setExistingComparison] = useState<ExistingFieldComparison[]>([]);
  const [intelligentMappings, setIntelligentMappings] = useState<IntelligentFieldMapping[]>([]);
  const [existingJiraFields, setExistingJiraFields] = useState<Array<{
    id: string; name: string; custom: boolean; schema?: { custom?: string; type?: string }
  }>>([]);
  const [structureBusy, setStructureBusy] = useState(false);
  const [structureResults, setStructureResults] = useState<Record<string, JiraStructureResult>>({});
  const [activationResults, setActivationResults] = useState<Record<string, ProjectActivationResult>>({});
  const [activationBusy, setActivationBusy] = useState(false);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenActivationBusy, setScreenActivationBusy] = useState(false);
  const [screenResults, setScreenResults] = useState<Record<string, ScreenStructureResult>>({});
  const [screenActivationResults, setScreenActivationResults] = useState<Record<string, ScreenActivationResult>>({});
  const [jsmBusy, setJsmBusy] = useState(false);
  const [jsmRequestResults, setJsmRequestResults] = useState<Record<string, JsmRequestTypeResult>>({});
  const [jsmFormResults, setJsmFormResults] = useState<Record<string, JsmFormResult>>({});
  const [jsmPortalResults, setJsmPortalResults] = useState<Record<string, JsmPortalResult>>({});
  const [healthResult, setHealthResult] = useState<EnvironmentHealthResult | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);
  const [validationSignoff, setValidationSignoff] = useState<Record<string, 'not-tested' | 'testing' | 'passed' | 'approved'>>({});
  const [manualPortalComplete, setManualPortalComplete] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke('getProjects')
      .then((raw) => {
        const items = raw as unknown as Project[];
        setJiraProjects(items ?? []);
        setMigration((current) => {
          if (current.targetProjectId) return current;
          const serviceProject = items?.find((project) => project.projectTypeKey === 'service_desk');
          return { ...current, targetProjectId: serviceProject?.id || items?.[0]?.id || '' };
        });
      })
      .catch((error: unknown) => {
        setMessage(`Could not load Jira projects: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);

  const activeService = useMemo(
    () => migration.services.find((service) => service.id === activeServiceId) || migration.services[0] || null,
    [migration.services, activeServiceId]
  );

  useEffect(() => {
    if (!activeServiceId && migration.services[0]) setActiveServiceId(migration.services[0].id);
  }, [migration.services, activeServiceId]);

  const sharedFields = useMemo(() => {
    const map = new Map<string, {
      name: string;
      type: JiraFieldType;
      types: Set<JiraFieldType>;
      services: string[];
      options: Set<string>;
      selected: boolean;
      description: string;
      ivantiName: string;
    }>();

    migration.services.forEach((service) => {
      service.analysis.fields.forEach((field) => {
        const key = String(field.name ?? '').trim().toLowerCase();
        const existing = map.get(key);
        if (existing) {
          existing.services.push(service.analysis.serviceName);
          existing.types.add(field.jiraType);
          field.options.forEach((option) => existing.options.add(option));
          existing.selected = existing.selected || field.selected;
        } else {
          map.set(key, {
            name: field.name,
            type: field.jiraType,
            types: new Set([field.jiraType]),
            services: [service.analysis.serviceName],
            options: new Set(field.options),
            selected: field.selected,
            description: field.description,
            ivantiName: field.ivantiName
          });
        }
      });
    });

    return [...map.values()]
      .map((item) => ({ ...item, types: [...item.types], options: [...item.options] }))
      .sort((a, b) => b.services.length - a.services.length || a.name.localeCompare(b.name));
  }, [migration.services]);

  const conflicts: PreflightConflict[] = useMemo(
    () => sharedFields
      .filter((field) => field.types.length > 1)
      .map((field) => ({
        fieldName: field.name,
        serviceNames: field.services,
        types: field.types,
        reason: 'The same Jira field name has been mapped to more than one field type.'
      })),
    [sharedFields]
  );

  const buildPlan: BuildPlan = useMemo(() => ({
    uniqueFields: sharedFields.length,
    selectedFields: sharedFields.filter((field) => field.selected).length,
    conflicts,
    servicesReady: migration.services.filter((service) => serviceReadiness(service) >= 80).length,
    servicesNeedingReview: migration.services.filter((service) => serviceReadiness(service) < 80).length
  }), [sharedFields, conflicts, migration.services]);

  const overall = useMemo(() => {
    const totalFields = migration.services.reduce((sum, service) => sum + service.analysis.fields.length, 0);
    const created = migration.services.reduce(
      (sum, service) => sum + service.build.fieldResults.filter((result) => ['created', 'reused'].includes(result.status)).length,
      0
    );
    const review = migration.services.filter((service) => !service.analysis.workflowItems.length).length;
    return { totalFields, created, review };
  }, [migration.services]);

  const migrationResult = useMemo(() => {
    const allResults = migration.services.flatMap((service) => service.build.fieldResults);
    return {
      created: allResults.filter((result) => result.status === 'created').length,
      reused: allResults.filter((result) => result.status === 'reused').length,
      partial: allResults.filter((result) => result.status === 'partial').length,
      failed: allResults.filter((result) => result.status === 'failed').length,
      formsPrepared: migration.services.filter((service) => service.formSections.length > 0).length,
      conditionsPrepared: migration.services.reduce((sum, service) => sum + service.proposedConditions.length, 0),
      workflowsPrepared: migration.services.filter((service) => service.analysis.suggestedWorkflow.statuses.length > 0).length,
      automationPrepared: migration.services.reduce((sum, service) => sum + automationBlueprint(service).length, 0)
    };
  }, [migration.services]);

  const dashboard = useMemo(() => {
    const services = migration.services.length;
    const formPlans = migration.services.filter((service) => service.formSections.length > 0).length;
    const workflowBlueprints = migration.services.filter((service) => service.analysis.suggestedWorkflow.statuses.length > 0).length;
    const automationRules = migration.services.reduce((sum, service) => sum + automationBlueprint(service).length, 0);
    const fieldsBuilt = migration.services.reduce(
      (sum, service) => sum + service.build.fieldResults.filter((result) => ['created', 'reused'].includes(result.status)).length,
      0
    );
    const readyServices = migration.services.filter((service) => serviceReadiness(service) >= 80).length;
    const completion = services
      ? Math.round(
          migration.services.reduce((sum, service) => sum + serviceReadiness(service), 0) / services
        )
      : 0;

    return {
      services,
      formPlans,
      workflowBlueprints,
      automationRules,
      fieldsBuilt,
      readyServices,
      completion
    };
  }, [migration.services]);

  function updateMigration(changes: Partial<MigrationProject>) {
    setMigration((current) => ({ ...current, ...changes, updatedAt: nowIso() }));
  }

  function updateService(serviceIdValue: string, updater: (service: MigrationService) => MigrationService) {
    setMigration((current) => ({
      ...current,
      updatedAt: nowIso(),
      services: current.services.map((service) => service.id === serviceIdValue ? updater(service) : service)
    }));
  }

  function saveProject() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...migration, updatedAt: nowIso() }));
    setSuccessMessage('Migration project saved in this browser.');
    setMessage('');
  }

  function loadProject() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      setMessage('No saved migration project was found in this browser.');
      return;
    }
    try {
      const saved = JSON.parse(raw) as MigrationProject;
      setMigration(saved);
      setActiveServiceId(saved.services[0]?.id || '');
      setMainView('dashboard');
      setServiceView('overview');
      setSuccessMessage(`Loaded ${saved.services.length} service${saved.services.length === 1 ? '' : 's'}.`);
      setMessage('');
    } catch {
      setMessage('The saved migration project could not be read.');
    }
  }

  async function importFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    setMessage('');
    setSuccessMessage('');
    const imported: MigrationService[] = [];

    for (const file of files) {
      try {
        const parsed = parseIvantiXml(await file.text(), file.name);
        const timestamp = nowIso();
        imported.push({
          id: serviceId(parsed.serviceName, file.name),
          sourceFile: file.name,
          importedAt: timestamp,
          updatedAt: timestamp,
          analysis: parsed,
          formSections: proposeFormSections(parsed),
          proposedConditions: proposeConditions(parsed),
          build: {
            fieldResults: [],
            formCreated: false,
            workflowCreated: false,
            automationGenerated: false
          }
        });
      } catch (error) {
        setMessage(`Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (imported.length) {
      setMigration((current) => ({
        ...current,
        updatedAt: nowIso(),
        services: [...current.services, ...imported]
      }));
      setActiveServiceId(imported[0].id);
      setMainView('services');
      setServiceView('overview');
      setSuccessMessage(`Imported ${imported.length} service${imported.length === 1 ? '' : 's'}.`);
    }
    event.target.value = '';
  }

  function deleteService(id: string) {
    const service = migration.services.find((item) => item.id === id);
    if (!service || !window.confirm(`Remove ${service.analysis.serviceName} from this migration project?`)) return;
    const remaining = migration.services.filter((item) => item.id !== id);
    updateMigration({ services: remaining });
    setActiveServiceId(remaining[0]?.id || '');
  }

  function updateField(fieldId: string, changes: Record<string, unknown>) {
    if (!activeService) return;
    updateService(activeService.id, (service) => ({
      ...service,
      updatedAt: nowIso(),
      analysis: {
        ...service.analysis,
        fields: service.analysis.fields.map((field) => field.id === fieldId ? { ...field, ...changes } : field)
      }
    }));
  }

  function toggleAll(selected: boolean) {
    if (!activeService) return;
    updateService(activeService.id, (service) => ({
      ...service,
      updatedAt: nowIso(),
      analysis: {
        ...service.analysis,
        fields: service.analysis.fields.map((field) => ({ ...field, selected }))
      }
    }));
  }

  function selectAllAcrossProject(selected: boolean) {
    setMigration((current) => ({
      ...current,
      updatedAt: nowIso(),
      services: current.services.map((service) => ({
        ...service,
        analysis: {
          ...service.analysis,
          fields: service.analysis.fields.map((field) => ({ ...field, selected }))
        }
      }))
    }));
  }

  function moveSection(index: number, direction: -1 | 1) {
    if (!activeService) return;
    updateService(activeService.id, (service) => {
      const next = [...service.formSections];
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= next.length) return service;
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return { ...service, updatedAt: nowIso(), formSections: next };
    });
  }

  function renameSection(id: string, name: string) {
    if (!activeService) return;
    updateService(activeService.id, (service) => ({
      ...service,
      updatedAt: nowIso(),
      formSections: service.formSections.map((section) => section.id === id ? { ...section, name } : section)
    }));
  }

  async function createFieldsForService(service: MigrationService) {
    const fields = service.analysis.fields.filter((field) => field.selected);
    if (!fields.length) throw new Error(`No fields selected for ${service.analysis.serviceName}.`);
    const response = (await invoke('createFields', {
      fields: fields.map(({ name, ivantiName, description, jiraType, options }) => ({
        name, ivantiName, description, jiraType, options
      })),
      projectId: migration.targetProjectId
    })) as unknown as CreationResult[];

    updateService(service.id, (current) => ({
      ...current,
      updatedAt: nowIso(),
      build: { ...current.build, fieldResults: response || [] }
    }));
    return response || [];
  }

  async function createFields() {
    if (!activeService) return;
    const fields = activeService.analysis.fields.filter((field) => field.selected);
    if (!fields.length) {
      setMessage('Select at least one field.');
      return;
    }
    if (!window.confirm(`Create or reuse ${fields.length} Jira custom fields for ${activeService.analysis.serviceName}?`)) return;

    setBusy(true);
    setMessage('');
    setSuccessMessage('');
    try {
      await createFieldsForService(activeService);
      setSuccessMessage('Jira field creation completed. Review the results below.');
    } catch (error) {
      setMessage(`Creation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyIntelligentMappings() {
    if (!intelligentMappings.length) {
      setMessage('Run Compare Jira before applying intelligent mappings.');
      return;
    }

    const actionable = intelligentMappings.filter((mapping) => mapping.action !== 'skip');
    if (!actionable.length) {
      setMessage('All mappings are set to Skip.');
      return;
    }

    if (!window.confirm(`Apply ${actionable.length} intelligent field mapping decisions in Jira?`)) return;

    setBulkBusy(true);
    setMessage('');
    setSuccessMessage('');

    try {
      const response = (await invoke('createFields', {
        fields: intelligentMappings.map((mapping) => ({
          name: mapping.proposedName,
          ivantiName: mapping.ivantiName,
          description: `Migrated from Ivanti field: ${mapping.ivantiName}`,
          jiraType: mapping.proposedType,
          options: mapping.options,
          action: mapping.action,
          existingFieldId: mapping.existingFieldId,
          existingFieldName: mapping.existingFieldName
        })),
        projectId: migration.targetProjectId
      })) as unknown as CreationResult[];

      setMigration((current) => ({
        ...current,
        updatedAt: nowIso(),
        services: current.services.map((service) => ({
          ...service,
          build: {
            ...service.build,
            fieldResults: response.filter((result) =>
              service.analysis.fields.some((field) =>
                String(field.name ?? '').trim().toLowerCase() === String(result.name ?? '').trim().toLowerCase()
              )
            )
          }
        }))
      }));

      addBuildLog(
        'success',
        'intelligent-mapping',
        `Applied ${response.length} mapping decisions: ${response.filter((item) => item.status === 'created').length} created, ${response.filter((item) => item.status === 'reused').length} reused.`
      );
      setSuccessMessage('Intelligent migration mapping completed.');
    } catch (error) {
      addBuildLog('error', 'intelligent-mapping', error instanceof Error ? error.message : String(error));
      setMessage(`Intelligent mapping failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkCreateUniqueFields() {
    if (conflicts.length) {
      setMessage('Resolve field-type conflicts before running the project build.');
      return;
    }

    const selected = sharedFields.filter((field) => field.selected);
    if (!selected.length) {
      setMessage('Select fields in at least one service before running the project build.');
      return;
    }

    if (!window.confirm(`Create or reuse ${selected.length} unique Jira custom fields across this migration project?`)) return;

    setBulkBusy(true);
    setMessage('');
    setSuccessMessage('');

    try {
      const response = (await invoke('createFields', {
        fields: selected.map((field) => ({
          name: field.name,
          ivantiName: field.ivantiName,
          description: field.description,
          jiraType: field.type,
          options: field.options
        })),
        projectId: migration.targetProjectId
      })) as unknown as CreationResult[];

      setMigration((current) => ({
        ...current,
        updatedAt: nowIso(),
        services: current.services.map((service) => ({
          ...service,
          build: {
            ...service.build,
            fieldResults: service.analysis.fields
              .filter((field) => field.selected)
              .map((field) => response.find((result) => result.name.toLowerCase() === field.name.toLowerCase()))
              .filter(Boolean) as CreationResult[]
          }
        }))
      }));

      setSuccessMessage(`Project field build completed for ${response.length} unique fields.`);
    } catch (error) {
      setMessage(`Project build failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBulkBusy(false);
    }
  }

  function addBuildLog(level: BuildLogEntry['level'], step: string, messageText: string) {
    setBuildLogs((current) => [...current, {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date().toLocaleTimeString(),
      level,
      step,
      message: messageText
    }]);
  }

  function saveCheckpoint(completedStepKeys: string[], failedStepKey?: string) {
    const next: BuildCheckpoint = {
      projectName: migration.name,
      targetProjectId: migration.targetProjectId,
      completedStepKeys,
      failedStepKey,
      updatedAt: nowIso()
    };
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(next));
    setCheckpoint(next);
  }

  function clearCheckpoint() {
    localStorage.removeItem(CHECKPOINT_KEY);
    setCheckpoint(null);
  }

  function normaliseName(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function tokenSet(value: string): Set<string> {
    return new Set(normaliseName(value).split(/\s+/).filter(Boolean));
  }

  function similarity(left: string, right: string): number {
    const a = normaliseName(left);
    const b = normaliseName(right);
    if (a === b) return 100;
    if (!a || !b) return 0;
    if (a.includes(b) || b.includes(a)) return 88;

    const aTokens = tokenSet(a);
    const bTokens = tokenSet(b);
    const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
    const union = new Set([...aTokens, ...bTokens]).size;
    return union ? Math.round((intersection / union) * 80) : 0;
  }

  function jiraTypeFamily(field: { schema?: { custom?: string; type?: string } }): string {
    const value = `${field.schema?.custom || ''} ${field.schema?.type || ''}`.toLowerCase();
    if (value.includes('select')) return 'select';
    if (value.includes('userpicker') || value.includes('user')) return 'user';
    if (value.includes('date')) return 'date';
    if (value.includes('float') || value.includes('number')) return 'number';
    if (value.includes('textarea')) return 'paragraph';
    if (value.includes('textfield') || value.includes('string')) return 'text';
    return 'unknown';
  }

  function buildIntelligentMappings(existing: Array<{
    id: string; name: string; custom: boolean; schema?: { custom?: string; type?: string }
  }>): IntelligentFieldMapping[] {
    const unique = new Map<string, {
      serviceId: string;
      sourceFieldId: string;
      ivantiName: string;
      name: string;
      type: JiraFieldType;
      options: string[];
    }>();

    migration.services.forEach((service) => {
      service.analysis.fields.forEach((field) => {
        const key = String(field.name ?? '').trim().toLowerCase();
        if (!unique.has(key)) {
          unique.set(key, {
            serviceId: service.id,
            sourceFieldId: field.id,
            ivantiName: field.ivantiName,
            name: field.name,
            type: field.jiraType,
            options: field.options
          });
        }
      });
    });

    return [...unique.values()].map((field) => {
      const candidates = existing
        .map((item) => ({
          item,
          nameScore: similarity(field.name, item.name),
          typeMatch: jiraTypeFamily(item) === field.type ||
            (field.type === 'checkbox' && jiraTypeFamily(item) === 'select')
        }))
        .sort((left, right) => {
          const leftScore = left.nameScore + (left.typeMatch ? 10 : 0);
          const rightScore = right.nameScore + (right.typeMatch ? 10 : 0);
          return rightScore - leftScore;
        });

      const best = candidates[0];
      if (!best || best.nameScore < 55) {
        return {
          key: field.name.toLowerCase(),
          serviceId: field.serviceId,
          sourceFieldId: field.sourceFieldId,
          ivantiName: field.ivantiName,
          proposedName: field.name,
          proposedType: field.type,
          options: field.options,
          action: 'create',
          confidence: 95,
          reason: 'No sufficiently similar Jira field was found.'
        };
      }

      const exact = normaliseName(field.name) === normaliseName(best.item.name);
      const compatible = best.typeMatch;
      const confidence = Math.min(100, best.nameScore + (compatible ? 10 : 0));
      const canMerge = compatible && ['select', 'checkbox'].includes(field.type) && field.options.length > 0;

      return {
        key: field.name.toLowerCase(),
        serviceId: field.serviceId,
        sourceFieldId: field.sourceFieldId,
        ivantiName: field.ivantiName,
        proposedName: field.name,
        proposedType: field.type,
        options: field.options,
        action: compatible ? (canMerge ? 'merge' : 'reuse') : 'create',
        existingFieldId: best.item.id,
        existingFieldName: best.item.name,
        existingType: best.item.schema?.custom || best.item.schema?.type || 'unknown',
        confidence,
        reason: exact
          ? 'Exact Jira field name match.'
          : compatible
            ? 'Similar name and compatible Jira field type.'
            : 'A similar field exists, but its type may not be compatible.'
      };
    });
  }

  function updateIntelligentMapping(key: string, changes: Partial<IntelligentFieldMapping>) {
    setIntelligentMappings((current) =>
      current.map((mapping) => mapping.key === key ? { ...mapping, ...changes } : mapping)
    );
  }

  async function compareExistingFields() {
    setMessage('');
    addBuildLog('info', 'comparison', 'Reading existing Jira fields.');
    try {
      const existing = (await invoke('getFields')) as unknown as Array<{
        id: string; name: string; custom: boolean; schema?: { custom?: string; type?: string }
      }>;
      const byName = new Map(existing.map((field) => [String(field.name ?? '').trim().toLowerCase(), field]));
      const comparisons: ExistingFieldComparison[] = sharedFields.map((field) => {
        const match = byName.get(String(field.name ?? '').trim().toLowerCase());
        if (!match) return { name: field.name, proposedType: field.type, status: 'new' };
        return {
          name: field.name,
          proposedType: field.type,
          status: 'reuse',
          existingId: match.id,
          existingType: match.schema?.custom || match.schema?.type || 'unknown'
        };
      });
      setExistingJiraFields(existing);
      setExistingComparison(comparisons);
      setIntelligentMappings(buildIntelligentMappings(existing));
      addBuildLog('success', 'comparison', `Compared ${comparisons.length} unique fields and generated intelligent recommendations.`);
    } catch (error) {
      addBuildLog('error', 'comparison', error instanceof Error ? error.message : String(error));
      setMessage(`Could not compare Jira fields: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function withRetry<T>(label: string, action: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        if (attempt > 1) addBuildLog('warning', label, `Retry ${attempt} of ${attempts}.`);
        return await action();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await new Promise((resolve) => window.setTimeout(resolve, attempt * 1000));
      }
    }
    throw lastError;
  }

  const orchestrationSteps = [
    { key: 'preflight', label: 'Run preflight', mode: 'live' },
    { key: 'fields', label: 'Create native Jira fields', mode: 'live' },
    { key: 'forms', label: 'Prepare JSM Form payloads', mode: 'blueprint' },
    { key: 'requestTypes', label: 'Prepare request type payloads', mode: 'blueprint' },
    { key: 'workflows', label: 'Prepare workflow payloads', mode: 'blueprint' },
    { key: 'automation', label: 'Prepare automation rules', mode: 'blueprint' },
    { key: 'report', label: 'Generate implementation report', mode: 'live' }
  ] as const;

  async function runOrchestrator(resume = false) {
    if (!migration.services.length) {
      setMessage('Import at least one service first.');
      return;
    }
    if (conflicts.length) {
      setMessage('Resolve shared-field type conflicts before running the wizard.');
      return;
    }

    setOrchestrationRunning(true);
    setMessage('');
    setSuccessMessage('');
    if (!resume) {
      setBuildLogs([]);
      setOrchestrationStep(0);
      clearCheckpoint();
    }

    const completed = resume && checkpoint ? [...checkpoint.completedStepKeys] : [];

    try {
      for (let index = 0; index < orchestrationSteps.length; index += 1) {
        const step = orchestrationSteps[index];
        if (completed.includes(step.key)) {
          setOrchestrationStep(index + 1);
          continue;
        }

        setOrchestrationStep(index + 1);
        addBuildLog('info', step.key, `Starting: ${step.label}`);

        if (step.key === 'preflight') {
          addBuildLog('success', step.key, 'Preflight passed.');
        } else if (step.key === 'fields') {
          if (intelligentMappings.length > 0) {
            await withRetry(step.key, async () => { await applyIntelligentMappings(); });
            addBuildLog('success', step.key, 'Intelligent Jira field mappings were processed.');
          } else if (buildPlan.selectedFields > 0) {
            await withRetry(step.key, async () => { await bulkCreateUniqueFields(); });
            addBuildLog('success', step.key, 'Selected Jira fields were processed.');
          } else {
            addBuildLog('warning', step.key, 'No intelligent mappings or selected fields were available.');
          }
        } else if (step.key === 'report') {
          exportProject();
          addBuildLog('success', step.key, 'Implementation pack exported.');
        } else {
          await new Promise((resolve) => window.setTimeout(resolve, 350));
          addBuildLog('success', step.key, `${step.label} completed as a blueprint.`);
        }

        completed.push(step.key);
        saveCheckpoint(completed);
      }
      setSuccessMessage('Migration completed. Jira fields were processed and the implementation pack was exported.');
    } catch (error) {
      const failedKey = orchestrationSteps[Math.max(0, orchestrationStep - 1)]?.key;
      saveCheckpoint(completed, failedKey);
      addBuildLog('error', failedKey || 'build', error instanceof Error ? error.message : String(error));
      setMessage(`Migration interrupted: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOrchestrationRunning(false);
    }
  }


  function safeFileName(value: string): string {
    return String(value || 'ivanti-migration')
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'ivanti-migration';
  }

  function automationCandidates(service: MigrationService): AutomationCandidate[] {
    const candidates: AutomationCandidate[] = [];
    const seen = new Set<string>();

    const add = (candidate: AutomationCandidate) => {
      const key = `${candidate.source}|${candidate.name.toLowerCase()}|${candidate.actions.join('|').toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    service.analysis.workflowItems.forEach((item) => {
      if (item.category === 'notification') {
        add({
          id: `auto-notify-${item.id}`,
          name: item.label || 'Ivanti notification',
          source: 'notification',
          trigger: 'Workflow event or transition — map during workflow review',
          conditions: item.condition ? [item.condition] : [],
          actions: [`Send notification: ${item.label}`],
          confidence: item.condition ? 75 : 65,
          status: 'review',
          reviewReason: 'Recipient, channel and exact trigger must be confirmed from Ivanti workflow metadata.'
        });
      }

      if ((item.category === 'task' || item.category === 'activity') && item.assignment) {
        add({
          id: `auto-assign-${item.id}`,
          name: `Assign: ${item.label}`,
          source: 'assignment',
          trigger: 'Work item created or workflow transition — confirm source event',
          conditions: item.condition ? [item.condition] : [],
          actions: [`Assign work item to: ${item.assignment}`],
          confidence: 70,
          status: 'review',
          reviewReason: 'Ivanti assignment target must be mapped to a Jira user, group or team.'
        });
      }

      if (item.category === 'condition') {
        add({
          id: `auto-condition-${item.id}`,
          name: `Conditional logic: ${item.label}`,
          source: 'condition',
          trigger: 'Related Jira event — requires trigger selection',
          conditions: [item.condition || item.label],
          actions: ['Action must be paired with the related Ivanti workflow activity.'],
          confidence: 45,
          status: 'manual',
          reviewReason: 'Condition evidence was detected without a safely paired Jira action.'
        });
      }

      if (item.category === 'approval') {
        add({
          id: `auto-approval-${item.id}`,
          name: `Approval: ${item.label}`,
          source: 'approval',
          trigger: 'JSM approval stage / workflow transition',
          conditions: item.condition ? [item.condition] : [],
          actions: ['Configure JSM approval and any follow-up automation after approval/rejection.'],
          confidence: 55,
          status: 'manual',
          reviewReason: 'Approvals should be modelled with JSM approval functionality first, then automation where needed.'
        });
      }
    });

    // Form conditions are already handled natively in Forms, but surface them so
    // admins do not accidentally recreate the same logic as Automation rules.
    service.proposedConditions.forEach((condition) => {
      const controller = service.analysis.fields.find((field) => field.id === condition.controllerFieldId);
      add({
        id: `auto-form-condition-${condition.id}`,
        name: `Form condition: ${controller?.name || condition.controllerFieldId}`,
        source: 'condition',
        trigger: 'JSM Form interaction',
        conditions: [`${controller?.name || condition.controllerFieldId} ${condition.operator} ${condition.value}`],
        actions: ['No Jira Automation rule required — implemented as native JSM Form conditional logic.'],
        confidence: 100,
        status: 'ready'
      });
    });

    return candidates;
  }

  function automationMigrationPack(service: MigrationService): AutomationMigrationPack {
    const candidates = automationCandidates(service);
    return {
      serviceName: service.analysis.serviceName,
      generatedAt: nowIso(),
      projectId: migration.targetProjectId,
      candidates,
      summary: {
        total: candidates.length,
        ready: candidates.filter((item) => item.status === 'ready').length,
        review: candidates.filter((item) => item.status === 'review').length,
        manual: candidates.filter((item) => item.status === 'manual').length
      },
      jiraAutomationApi: {
        directForgeCreationSupported: false,
        reason: 'Atlassian Automation Rule Management REST resources currently state that Forge and OAuth2 apps cannot access them. v6.1 therefore generates a reviewed migration pack instead of claiming to create rules directly.'
      }
    };
  }

  function exportAutomationPack(service: MigrationService) {
    const pack = automationMigrationPack(service);
    downloadJson(`${safeFileName(service.analysis.serviceName)}-automation-migration-pack.json`, pack);
    setSuccessMessage(`Exported automation migration pack with ${pack.summary.total} candidate(s).`);
  }

  function workflowEngineRequest(service: MigrationService) {
    return {
      serviceName: service.analysis.serviceName,
      description: service.analysis.description,
      statuses: service.analysis.workflowMigration.statuses.map((status) => ({
        name: status.name,
        statusCategory: status.statusCategory
      })),
      transitions: service.analysis.workflowMigration.transitions
        .filter((transition) => transition.fromStatus && transition.toStatus)
        .map((transition) => ({
          name: transition.name,
          fromStatus: transition.fromStatus,
          toStatus: transition.toStatus,
          condition: transition.condition,
          assignment: transition.assignment
        }))
    };
  }

  async function validateWorkflowEngine(service: MigrationService) {
    setWorkflowEngineBusy(true);
    setMessage('');
    setSuccessMessage('');
    try {
      const result = await invoke('validateIvantiWorkflow', workflowEngineRequest(service)) as unknown as WorkflowMigrationResult;
      setWorkflowEngineResults((current) => ({ ...current, [service.id]: result }));
      setSuccessMessage(result.message);
    } catch (error) {
      setMessage(`Workflow dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWorkflowEngineBusy(false);
    }
  }

  async function createWorkflowEngine(service: MigrationService) {
    if (!window.confirm(
      `Create the versioned Jira workflow "${service.analysis.serviceName} - Ivanti Workflow v6"?\n\n` +
      `This creates a new workflow rather than overwriting the existing live workflow. Ambiguous approvals, notifications and conditions remain review items.`
    )) return;

    setWorkflowEngineBusy(true);
    setMessage('');
    setSuccessMessage('');
    try {
      const result = await invoke('createIvantiWorkflow', workflowEngineRequest(service)) as unknown as WorkflowMigrationResult;
      setWorkflowEngineResults((current) => ({ ...current, [service.id]: result }));
      setSuccessMessage(result.message);
    } catch (error) {
      setMessage(`Workflow creation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWorkflowEngineBusy(false);
    }
  }

  async function createJiraStructure(service: MigrationService) {
    const statuses = service.analysis.suggestedWorkflow.statuses.length >= 2
      ? service.analysis.suggestedWorkflow.statuses
      : ['Submitted', 'Provisioning', 'Completed'];

    if (!window.confirm(
      `Create or reuse the issue type, workflow and inactive workflow scheme for "${service.analysis.serviceName}"?`
    )) return;

    setStructureBusy(true);
    setMessage('');
    setSuccessMessage('');

    try {
      const result = (await invoke('createJiraStructure', {
        serviceName: service.analysis.serviceName,
        description: service.analysis.description,
        statuses,
        createIssueType: true,
        createWorkflow: true,
        createWorkflowScheme: true
      })) as unknown as JiraStructureResult;

      setStructureResults((current) => ({ ...current, [service.id]: result }));
      addBuildLog(
        result.status === 'failed' ? 'error' : result.status === 'partial' ? 'warning' : 'success',
        'jira-structure',
        `${service.analysis.serviceName}: ${result.status}.`
      );
      setSuccessMessage(
        result.status === 'created'
          ? 'Jira issue type, workflow and workflow scheme were processed successfully.'
          : 'Jira structure creation completed with items requiring review.'
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      addBuildLog('error', 'jira-structure', text);
      setMessage(`Could not create Jira structure: ${text}`);
    } finally {
      setStructureBusy(false);
    }
  }


  async function createScreenStructure(service: MigrationService) {
    const structure = structureResults[service.id];
    if (!structure?.issueTypeId) { setMessage('Create or reuse the Jira issue type first.'); return; }
    const fieldResults = service.build.fieldResults ?? [];
    const resultByName = new Map(
      fieldResults
        .filter((field) => field.id)
        .map((field) => [field.name.trim().toLowerCase(), field])
    );
    // Always send every analysed Ivanti field. The backend resolves its Jira field ID
    // by exact name when this browser session has no prior field-build results.
    const fields = service.analysis.fields.map((field) => {
      const result = resultByName.get(field.name.trim().toLowerCase());
      return { id: result?.id ? String(result.id) : undefined, name: field.name };
    });
    if (!window.confirm(`Create or reuse the Jira screens and screen schemes for "${service.analysis.serviceName}"?`)) return;
    setScreenBusy(true); setMessage(''); setSuccessMessage('');
    try {
      const result = await invoke('createScreenStructure', {
        serviceName: service.analysis.serviceName,
        issueTypeId: structure.issueTypeId,
        fields
      }) as unknown as ScreenStructureResult;
      setScreenResults((current) => ({ ...current, [service.id]: result }));
      setSuccessMessage(result.status === 'created' ? 'Screens and screen schemes were processed successfully.' : 'Screen creation completed with items requiring review.');
    } catch (error) {
      setMessage(`Could not create screens: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setScreenBusy(false); }
  }

  async function assignScreenScheme(service: MigrationService) {
    const result = screenResults[service.id];
    if (!result?.issueTypeScreenSchemeId) { setMessage('Create or reuse the issue type screen scheme first.'); return; }
    if (!migration.targetProjectId) { setMessage('Choose a target Jira project in Settings first.'); return; }
    if (!window.confirm('Assign this issue type screen scheme to the selected target project?')) return;
    setScreenActivationBusy(true); setMessage(''); setSuccessMessage('');
    try {
      const activation = await invoke('assignIssueTypeScreenSchemeToProject', {
        projectId: migration.targetProjectId,
        issueTypeScreenSchemeId: result.issueTypeScreenSchemeId
      }) as unknown as ScreenActivationResult;
      setScreenActivationResults((current) => ({ ...current, [service.id]: activation }));
      setSuccessMessage(activation.message);
    } catch (error) {
      setMessage(`Could not assign the screen scheme: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setScreenActivationBusy(false); }
  }


  async function buildJsmExperience(service: MigrationService) {
    const structure = structureResults[service.id];
    if (!migration.targetProjectId) { setMessage('Choose a target JSM project in Settings first.'); return; }
    if (!structure?.issueTypeId) { setMessage('Create or reuse the Jira issue type first.'); return; }
    if (!window.confirm(`prepare the Jira work type in the target project, reuse/create one canonical request type, populate the Form, read it back from Jira, publish it, and verify the result for "${service.analysis.serviceName}"?`)) return;
    setJsmBusy(true); setMessage(''); setSuccessMessage('');
    setJsmPortalResults((current) => { const next = { ...current }; delete next[service.id]; return next; });
    try {
      let requestType: JsmRequestTypeResult;
      try {
        requestType = await invoke('createJsmRequestType', {
          projectId: migration.targetProjectId,
          issueTypeId: structure.issueTypeId,
          name: service.analysis.serviceName,
          description: service.analysis.description || `Migrated from Ivanti: ${service.analysis.serviceName}`
        }) as unknown as JsmRequestTypeResult;
        setJsmRequestResults((current) => ({ ...current, [service.id]: requestType }));
      } catch (error) {
        setMessage(`Request type stage failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      const resultByName = new Map((service.build.fieldResults ?? []).filter((field) => field.id).map((field) => [field.name.trim().toLowerCase(), field]));
      const fields = service.analysis.fields.map((field) => ({ sourceId: field.id, id: resultByName.get(field.name.trim().toLowerCase())?.id, name: field.name, required: field.required, jiraType: field.jiraType, options: field.options }));
      const form = await invoke('createJsmForm', {
        projectId: migration.targetProjectId,
        requestTypeId: requestType.requestTypeId,
        name: `${service.analysis.serviceName} - Ivanti Migration Form`,
        fields,
        sections: service.formSections,
        conditions: service.proposedConditions
      }) as unknown as JsmFormResult;
      setJsmFormResults((current) => ({ ...current, [service.id]: form }));

      if (!form.published) {
        setMessage(`JSM Form stage requires review: ${form.message}`);
        return;
      }

      try {
        const portal = await invoke('verifyJsmPortal', {
          projectId: migration.targetProjectId,
          requestTypeId: requestType.requestTypeId,
          issueTypeId: structure.issueTypeId
        }) as unknown as JsmPortalResult;
        setJsmPortalResults((current) => ({ ...current, [service.id]: portal }));
        setSuccessMessage(`JSM build completed: ${requestType.message} ${form.message} ${portal.message}`);
      } catch (error) {
        setMessage(`Portal verification stage failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      setMessage(`JSM Form stage failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setJsmBusy(false); }
  }


  async function removeDuplicateRequestTypes(service: MigrationService) {
    const request = jsmRequestResults[service.id];
    const duplicates = request?.duplicates ?? [];
    if (!request || !duplicates.length) {
      setMessage('No duplicate request types are currently recorded for this service.');
      return;
    }
    const ids = duplicates.map((item) => item.id);
    if (!window.confirm(`Delete ${ids.length} duplicate JSM request type(s)? The canonical request type ${request.requestTypeId} will be kept. This cannot be undone.`)) return;

    setJsmBusy(true);
    setMessage('');
    setSuccessMessage('');
    try {
      const result = await invoke('deleteDuplicateJsmRequestTypes', {
        serviceDeskId: request.serviceDeskId,
        keepRequestTypeId: request.requestTypeId,
        duplicateIds: ids
      }) as unknown as JsmDuplicateCleanupResult;

      setJsmRequestResults((current) => ({
        ...current,
        [service.id]: { ...request, duplicates: result.failed ? duplicates.filter((dup) => result.results.some((r: { id: string; status: 'deleted' | 'failed'; message: string }) => r.id === dup.id && r.status === 'failed')) : [] }
      }));
      setSuccessMessage(result.message);
    } catch (error) {
      setMessage(`Could not remove duplicate request types: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setJsmBusy(false);
    }
  }


  async function assignWorkflowScheme(service: MigrationService) {
    const structure = structureResults[service.id];
    if (!structure?.workflowSchemeId) {
      setMessage('Create or reuse the Jira workflow scheme first.');
      return;
    }
    if (!migration.targetProjectId) {
      setMessage('Choose a target Jira project in Settings first.');
      return;
    }
    const selectedProject = jiraProjects.find((project) => project.id === migration.targetProjectId);
    if (!selectedProject) {
      setMessage('The selected Jira project could not be found. Reload the app and choose it again.');
      return;
    }
    if (selectedProject.simplified) {
      setMessage('Choose a company-managed project. Jira cannot assign workflow schemes to team-managed projects.');
      return;
    }
    if (!window.confirm(
      `Assign workflow scheme ${structure.workflowSchemeId} to ${selectedProject.name} (${selectedProject.key})? Jira only permits this direct assignment when the project has no issues.`
    )) return;

    setActivationBusy(true);
    setMessage('');
    setSuccessMessage('');
    try {
      const result = (await invoke('assignWorkflowSchemeToProject', {
        projectId: migration.targetProjectId,
        workflowSchemeId: structure.workflowSchemeId
      })) as unknown as ProjectActivationResult;
      setActivationResults((current) => ({ ...current, [service.id]: result }));
      addBuildLog('success', 'project-activation', result.message);
      setSuccessMessage(result.message);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      addBuildLog('error', 'project-activation', text);
      setMessage(`Could not assign the workflow scheme: ${text}`);
    } finally {
      setActivationBusy(false);
    }
  }

  function validationFor(service: MigrationService) {
    const fieldBuilt = service.build.fieldResults.filter((r) => ['created', 'reused'].includes(r.status)).length;
    const structure = structureResults[service.id];
    const screens = screenResults[service.id];
    const screenActivation = screenActivationResults[service.id];
    const request = jsmRequestResults[service.id];
    const form = jsmFormResults[service.id];
    const portal = jsmPortalResults[service.id];
    const automation = automationMigrationPack(service);
    const workflowSource = service.analysis.workflowItems.length > 0;
    const portalDone = !!portal?.visibleInPortal || !!manualPortalComplete[service.id];
    const items = [
      { key:'source-fields', label:'Ivanti fields', status: service.analysis.fields.length ? 'pass' : 'fail', source:String(service.analysis.fields.length), jira:String(fieldBuilt), message: service.analysis.fields.length ? `${service.analysis.fields.length} source field(s) analysed.` : 'No Ivanti fields were detected.' },
      { key:'jira-fields', label:'Jira fields', status: fieldBuilt >= service.analysis.fields.length && service.analysis.fields.length ? 'pass' : fieldBuilt ? 'warning' : 'warning', source:String(service.analysis.fields.length), jira:String(fieldBuilt), message: fieldBuilt >= service.analysis.fields.length && service.analysis.fields.length ? 'All analysed fields have creation/reuse evidence.' : `${fieldBuilt}/${service.analysis.fields.length} fields have build evidence in this session.` },
      { key:'screens', label:'Screens & schemes', status: screens?.status === 'created' && !!screenActivation ? 'pass' : screens?.status === 'failed' ? 'fail' : 'warning', source:'Required', jira: screens ? screens.status : 'Not run', message: screenActivation ? 'Screen structure is built and assigned to the target project.' : screens ? 'Screen structure exists; project assignment still needs verification.' : 'Screen build has not been run in this session.' },
      { key:'request-type', label:'JSM request type', status: request ? 'pass' : 'warning', source:service.analysis.serviceName, jira:request?.requestTypeId || 'Not verified', message: request ? `Request type ${request.requestTypeId} is linked to the migrated service.` : 'Request type has not been verified in this session.' },
      { key:'form', label:'JSM Form', status: form?.published && form.resolvedFields === form.totalFields ? 'pass' : form?.status === 'failed' ? 'fail' : 'warning', source:`${service.analysis.fields.length} fields / ${service.formSections.length} sections`, jira:form ? `${form.resolvedFields}/${form.totalFields} fields` : 'Not verified', message: form?.published ? `Published Form ${form.formId}; ${form.resolvedFields}/${form.totalFields} fields resolved.` : 'Published Form read-back has not been verified in this session.' },
      { key:'conditions', label:'Form conditions', status: !service.proposedConditions.length ? 'pass' : form?.stages?.find(x=>x.key==='conditions')?.status === 'verified' ? 'pass' : form?.stages?.find(x=>x.key==='conditions')?.status === 'failed' ? 'fail' : 'warning', source:String(service.proposedConditions.length), jira: form?.stages?.find(x=>x.key==='conditions')?.status || 'Not verified', message: service.proposedConditions.length ? `${service.proposedConditions.length} inferred condition(s) expected.` : 'No conditional rules expected.' },
      { key:'portal', label:'Portal visibility', status: portalDone ? 'pass' : portal ? 'warning' : 'warning', source:'Portal group required', jira: portalDone ? 'Complete' : 'Manual step', message: portalDone ? 'Portal visibility is confirmed or the manual portal-group step has been signed off.' : 'Assign the request type to a portal group, then mark this step complete.' },
      { key:'workflow-source', label:'Workflow source data', status: workflowSource ? 'pass' : 'blocked', source: workflowSource ? `${service.analysis.workflowItems.length} item(s)` : 'Missing', jira: structure?.workflowId || 'Waiting', message: workflowSource ? 'Workflow metadata is available for validation.' : 'Blocked by missing Ivanti workflow export; this is not a Jira build failure.' },
      { key:'automation', label:'Automation accounted for', status: automation.summary.review === 0 && automation.summary.manual === 0 ? 'pass' : 'warning', source:String(automation.candidates.length), jira:`${automation.summary.ready} handled`, message: `${automation.summary.ready} already handled, ${automation.summary.review} review, ${automation.summary.manual} manual design.` },
    ] as Array<{key:string;label:string;status:'pass'|'warning'|'fail'|'blocked';source:string;jira:string;message:string}>;
    const failures=items.filter(i=>i.status==='fail').length;
    const blockers=items.filter(i=>i.status==='blocked').length;
    const warnings=items.filter(i=>i.status==='warning').length;
    const pass=items.filter(i=>i.status==='pass').length;
    const score=Math.round((pass / items.length) * 100);
    const classification = failures ? 'Migration failed validation' : blockers ? 'Blocked by source data' : warnings ? 'Automatic with manual steps' : 'Ready for testing';
    return { items, failures, blockers, warnings, pass, score, classification, signoff: validationSignoff[service.id] || 'not-tested' };
  }

  function exportValidationReport(service: MigrationService) {
    const validation=validationFor(service);
    downloadJson(`${safeFileName(service.analysis.serviceName)}-validation-report.json`, {
      version:'6.2.0', generatedAt:nowIso(), migration:migration.name, targetProjectId:migration.targetProjectId,
      service:service.analysis.serviceName, sourceFile:service.sourceFile, ...validation,
      jiraIds:{ issueTypeId:structureResults[service.id]?.issueTypeId, workflowId:structureResults[service.id]?.workflowId, workflowSchemeId:structureResults[service.id]?.workflowSchemeId, issueTypeScreenSchemeId:screenResults[service.id]?.issueTypeScreenSchemeId, requestTypeId:jsmRequestResults[service.id]?.requestTypeId, formId:jsmFormResults[service.id]?.formId },
      manualActions:{ portalGroupComplete:!!manualPortalComplete[service.id] }
    });
  }

  function downloadJson(fileName: string, payload: unknown) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv(fileName: string, rows: string[][]) {
    const escaped = rows.map((row) => row.map((cell) => {
      const value = String(cell ?? '');
      return `"${value.replace(/"/g, '""')}"`;
    }).join(',')).join('\r\n');
    const blob = new Blob([escaped], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportFieldMappingCsv() {
    const rows = [['Service', 'Ivanti field', 'Jira field', 'Jira type', 'Required', 'Options']];
    migration.services.forEach((service) => {
      service.analysis.fields.forEach((field) => {
        rows.push([
          service.analysis.serviceName,
          field.ivantiName,
          field.name,
          field.jiraType,
          field.required ? 'Yes' : 'No',
          field.options.join(' | ')
        ]);
      });
    });
    exportCsv(`${slug(migration.name)}-field-mapping.csv`, rows);
  }

  function exportImplementationChecklistCsv() {
    const rows = [['Service', 'Readiness', 'Fields', 'Form sections', 'Conditions', 'Workflow metadata', 'Fields built']];
    migration.services.forEach((service) => {
      rows.push([
        service.analysis.serviceName,
        `${serviceReadiness(service)}%`,
        String(service.analysis.fields.length),
        String(service.formSections.length),
        String(service.proposedConditions.length),
        String(service.analysis.workflowItems.length),
        String(service.build.fieldResults.filter((result) => ['created', 'reused'].includes(result.status)).length)
      ]);
    });
    exportCsv(`${slug(migration.name)}-implementation-checklist.csv`, rows);
  }

  function exportProject() {
    const selectedProject = jiraProjects.find((project) => project.id === migration.targetProjectId);
    downloadJson(`${slug(migration.name)}-migration-project.json`, {
      ...migration,
      exportedAt: nowIso(),
      targetProject: selectedProject || null,
      implementationBlueprints: migration.services.map(implementationBlueprint),
      preflight: buildPlan,
      limitations: [
        'v1.0 creates native Jira custom fields, field contexts and options.',
        'JSM Forms, request types, workflows and Jira Automation are exported as reviewed implementation blueprints.',
        'Those configuration types are not silently created by this release.'
      ]
    });
  }

  function exportServiceBlueprint(service: MigrationService) {
    downloadJson(`${slug(service.analysis.serviceName)}-implementation-blueprint.json`, implementationBlueprint(service));
  }

  async function runEnvironmentHealthCheck() {
    setHealthBusy(true);
    setMessage('');
    try {
      const result = await invoke('getEnvironmentHealth', { projectId: migration.targetProjectId }) as unknown as EnvironmentHealthResult;
      setHealthResult(result);
      setSuccessMessage(result.ready ? 'Environment check passed. The selected project is ready for migration.' : 'Environment check completed. Resolve the failed checks before building.');
    } catch (error) {
      setMessage(`Environment check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setHealthBusy(false);
    }
  }

  const selectedCount = activeService?.analysis.fields.filter((field) => field.selected).length || 0;
  const filteredWorkflow = activeService
    ? (workflowFilter === 'all'
      ? activeService.analysis.workflowItems
      : activeService.analysis.workflowItems.filter((item) => item.category === workflowFilter))
    : [];

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">IA</div>
          <div><strong>Ivanti Migration</strong><span>Forge v6.2</span></div>
        </div>

        <nav className="sideNav">
          <button className={mainView === 'dashboard' ? 'active' : ''} onClick={() => setMainView('dashboard')}>Dashboard</button>
          <button className={mainView === 'services' ? 'active' : ''} onClick={() => setMainView('services')}>Services <span>{migration.services.length}</span></button>
          <button className={mainView === 'shared-fields' ? 'active' : ''} onClick={() => setMainView('shared-fields')}>Shared fields <span>{sharedFields.length}</span></button>
          <button className={mainView === 'build' ? 'active' : ''} onClick={() => setMainView('build')}>Create fields</button>
          <button className={mainView === 'orchestrator' ? 'active' : ''} onClick={() => setMainView('orchestrator')}>Migration wizard</button>
          <button className={mainView === 'report' ? 'active' : ''} onClick={() => setMainView('report')}>Migration report</button>
          <button className={mainView === 'validation' ? 'active' : ''} onClick={() => setMainView('validation')}>Test & validation</button>
          <button className={mainView === 'health' ? 'active' : ''} onClick={() => setMainView('health')}>Health check</button>
          <button className={mainView === 'settings' ? 'active' : ''} onClick={() => setMainView('settings')}>Settings</button>
        </nav>

        <div className="sidebarActions">
          <button onClick={() => fileInput.current?.click()}>+ Import service</button>
          <input ref={fileInput} type="file" multiple accept=".xml,.rox,.txt,text/xml,application/xml" onChange={importFiles} hidden />
          <button className="secondary" onClick={saveProject}>Save project</button>
        </div>
      </aside>

      <section className="content">
        <header className="topBar">
          <div>
            <input className="projectName" value={migration.name} onChange={(event) => updateMigration({ name: event.target.value })} />
            <p>{migration.services.length} service{migration.services.length === 1 ? '' : 's'} · {overall.totalFields} field references · {sharedFields.length} unique fields</p>
          </div>
          <div className="topActions">
            <button className="secondary" onClick={loadProject}>Load saved</button>
            <button className="secondary" onClick={exportProject} disabled={!migration.services.length}>Export implementation pack</button>
          </div>
        </header>

        {message && <div className="alert error">{message}</div>}
        {successMessage && <div className="alert success">{successMessage}</div>}


        {mainView === 'dashboard' && (
          <section className="dashboardPage">
            <div className="dashboardHero">
              <div>
                <p className="eyebrow dark">Migration dashboard</p>
                <h1>{migration.name}</h1>
                <p>Overall progress across all imported Ivanti services.</p>
              </div>
              <div className="qualityBlock">
                <div className="completionRing" style={{ '--progress': `${dashboard.completion}%` } as React.CSSProperties}>
                  <strong>{dashboard.completion}%</strong>
                  <span>complete</span>
                </div>
                <span className={`qualityBadge ${qualityLabel(dashboard.completion).tone}`}>{qualityLabel(dashboard.completion).label}</span>
              </div>
            </div>

            <div className="dashboardMetrics">
              <article><strong>{dashboard.services}</strong><span>Services imported</span></article>
              <article><strong>{sharedFields.length}</strong><span>Unique fields</span></article>
              <article><strong>{dashboard.formPlans}</strong><span>Form plans</span></article>
              <article><strong>{dashboard.workflowBlueprints}</strong><span>Workflow blueprints</span></article>
              <article><strong>{dashboard.automationRules}</strong><span>Automation rules</span></article>
              <article><strong>{dashboard.fieldsBuilt}</strong><span>Fields created/reused</span></article>
              <article><strong>{Math.max(1, Math.ceil((sharedFields.length + dashboard.automationRules) / 25))} min</strong><span>Estimated review time</span></article>
            </div>

            <div className="dashboardGrid">
              <section className="panel">
                <div className="row"><div><h2>Service progress</h2><p className="hint">{dashboard.readyServices} of {dashboard.services} services are at least 80% ready.</p></div><button onClick={() => setMainView('services')}>Open services</button></div>
                <div className="progressList">
                  {migration.services.map((service) => (
                    <article key={service.id}>
                      <div><strong>{service.analysis.serviceName}</strong><p>{service.analysis.fields.length} fields · {service.formSections.length} sections · {automationBlueprint(service).length} automation rules</p></div>
                      <div className="progressValue"><span>{serviceReadiness(service)}%</span><div><i style={{ width: `${serviceReadiness(service)}%` }} /></div></div>
                    </article>
                  ))}
                  {!migration.services.length && <div className="emptyState"><strong>No services imported</strong><p>Use Import service to begin.</p></div>}
                </div>
              </section>

              <aside className="panel nextSteps">
                <h2>Next steps</h2>
                <ol>
                  <li className={migration.services.length ? 'done' : ''}><span>1</span><div><strong>Import services</strong><p>Add ROX/XML exports.</p></div></li>
                  <li className={sharedFields.length ? 'done' : ''}><span>2</span><div><strong>Review shared fields</strong><p>Resolve duplicates and type conflicts.</p></div></li>
                  <li className={buildPlan.conflicts.length === 0 && buildPlan.selectedFields > 0 ? 'done' : ''}><span>3</span><div><strong>Run preflight</strong><p>Select project fields and clear conflicts.</p></div></li>
                  <li className={dashboard.fieldsBuilt ? 'done' : ''}><span>4</span><div><strong>Create Jira fields</strong><p>Build the deduplicated field set.</p></div></li>
                  <li><span>5</span><div><strong>Export implementation pack</strong><p>Use blueprints for Forms, workflows and automation.</p></div></li>
                </ol>
                <button onClick={() => setMainView('build')}>Open Create in Jira</button>
              </aside>
            </div>
          </section>
        )}

        {mainView === 'services' && (
          <>
            {!migration.services.length ? (
              <section className="emptyWelcome">
                <div className="emptyIcon">⇧</div>
                <h1>Import your Ivanti catalogue</h1>
                <p>Select one or several ROX/XML exports. Each service remains available in this migration project.</p>
                <button onClick={() => fileInput.current?.click()}>Choose Ivanti files</button>
              </section>
            ) : (
              <div className="workspaceLayout">
                <aside className="serviceRail">
                  <div className="railHeader"><strong>Services</strong><button onClick={() => fileInput.current?.click()}>+</button></div>
                  {migration.services.map((service) => (
                    <button key={service.id} className={`serviceItem ${activeService?.id === service.id ? 'active' : ''}`} onClick={() => { setActiveServiceId(service.id); setServiceView('overview'); }}>
                      <span className="serviceStatus">{serviceReadiness(service)}%</span>
                      <span><strong>{service.analysis.serviceName}</strong><small>{service.sourceFile}</small></span>
                    </button>
                  ))}
                </aside>

                {activeService && (
                  <section className="serviceWorkspace">
                    <div className="serviceHero">
                      <div>
                        <p className="eyebrow dark">Selected service</p>
                        <h1>{activeService.analysis.serviceName}</h1>
                        <p>{activeService.analysis.description || 'No service description was found.'}</p>
                      </div>
                      <div className="serviceHeroActions">
                        <div className="readinessBlock"><span className="readiness">{serviceReadiness(activeService)}% ready</span><ul className="miniChecklist"><li className="done">Fields analysed</li><li className="done">Form generated</li><li className={activeService.proposedConditions.length ? 'review' : 'pending'}>Conditions reviewed</li><li className="pending">Workflow reviewed</li><li className={activeService.build.fieldResults.length ? 'done' : 'pending'}>Built in Jira</li></ul></div>
                        <button className="secondary" onClick={() => exportServiceBlueprint(activeService)}>Export blueprint</button>
                        <button className="dangerText" onClick={() => deleteService(activeService.id)}>Remove</button>
                      </div>
                    </div>

                    <div className="serviceHealth">
                      <article className="ready"><span /><div><strong>Fields</strong><p>{activeService.analysis.fields.length} detected</p></div></article>
                      <article className="ready"><span /><div><strong>Form plan</strong><p>{activeService.formSections.length} sections</p></div></article>
                      <article className={activeService.proposedConditions.length ? 'review' : 'missing'}><span /><div><strong>Conditions</strong><p>{activeService.proposedConditions.length} inferred</p></div></article>
                      <article className={activeService.analysis.workflowItems.length ? 'review' : 'missing'}><span /><div><strong>Workflow</strong><p>{activeService.analysis.workflowItems.length || 'No'} metadata</p></div></article>
                      <article className={activeService.build.fieldResults.length ? 'ready' : 'notStarted'}><span /><div><strong>Jira build</strong><p>{activeService.build.fieldResults.length ? 'Fields processed' : 'Not started'}</p></div></article>
                    </div>

                    <nav className="tabs">
                      {(['overview', 'fields', 'form', 'workflow', 'automation', 'create'] as ServiceView[]).map((item) => (
                        <button key={item} className={serviceView === item ? 'active' : ''} onClick={() => setServiceView(item)}>
                          {item === 'overview' ? 'Overview' :
                           item === 'fields' ? `Fields (${activeService.analysis.fields.length})` :
                           item === 'form' ? `Form (${activeService.formSections.length})` :
                           item === 'workflow' ? `Workflow (${activeService.analysis.workflowItems.length})` :
                           item === 'automation' ? `Automation (${automationCandidates(activeService).length})` : 'Create'}
                        </button>
                      ))}
                    </nav>

                    {serviceView === 'overview' && (
                      <section className="panel">
                        <h2>Service overview</h2>
                        <div className="metricGrid">
                          <div><strong>{activeService.analysis.fields.length}</strong><span>Fields</span></div>
                          <div><strong>{activeService.formSections.length}</strong><span>Form sections</span></div>
                          <div><strong>{activeService.proposedConditions.length}</strong><span>Conditions</span></div>
                          <div><strong>{activeService.analysis.suggestedWorkflow.taskNames.length}</strong><span>Suggested tasks</span></div>
                        </div>
                        <div className="sourceNotice"><strong>Detected:</strong> service details and fields. <strong>Proposed:</strong> form grouping, conditions, workflow and automation blueprints.</div>
                      </section>
                    )}

                    {serviceView === 'fields' && (
                      <section className="panel">
                        <div className="row">
                          <div><h2>Field mappings</h2><p className="hint">Existing fields are reused by exact name.</p></div>
                          <div className="actions"><button className="secondary" onClick={() => toggleAll(true)}>Select all</button><button className="secondary" onClick={() => toggleAll(false)}>Clear all</button></div>
                        </div>
                        <div className="tableWrap">
                          <table>
                            <thead><tr><th>Create</th><th>Ivanti field</th><th>Jira field name</th><th>Jira type</th><th>Required</th><th>Options</th></tr></thead>
                            <tbody>
                              {activeService.analysis.fields.map((field) => (
                                <tr key={field.id}>
                                  <td><input type="checkbox" checked={field.selected} onChange={(event) => updateField(field.id, { selected: event.target.checked })} /></td>
                                  <td><strong>{field.ivantiName}</strong><small>{field.rawType}</small></td>
                                  <td><input value={field.name} onChange={(event) => updateField(field.id, { name: event.target.value })} /></td>
                                  <td><select value={field.jiraType} onChange={(event) => updateField(field.id, { jiraType: event.target.value as JiraFieldType })}>
                                    {TYPE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                                  </select></td>
                                  <td>{field.required ? 'Yes' : 'No'}</td>
                                  <td>{field.options.length ? field.options.join(', ') : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="footerAction"><span>{selectedCount} selected</span><button disabled={busy || !selectedCount} onClick={createFields}>{busy ? 'Creating…' : 'Create selected Jira fields'}</button></div>
                        {!!activeService.build.fieldResults.length && (
                          <div className="results compactResults">
                            {activeService.build.fieldResults.map((result, index) => (
                              <div key={`${result.name}-${index}`} className={`result ${result.status}`}>
                                <strong>{result.name}</strong><span>{result.status}</span>{result.id && <code>{result.id}</code>}
                                {result.message && <p>{result.message}</p>}
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    )}

                    {serviceView === 'form' && (
                      <section className="panel">
                        <div className="row"><div><h2>Proposed JSM Form</h2><p className="hint">Rename and reorder inferred sections.</p></div><span className="proposalBadge">Blueprint</span></div>
                        <div className="sectionList">
                          {activeService.formSections.map((section, index) => (
                            <article className="formSection" key={section.id}>
                              <div className="sectionHeader">
                                <input value={section.name} onChange={(event) => renameSection(section.id, event.target.value)} />
                                <div className="sectionActions"><button className="secondary compact" onClick={() => moveSection(index, -1)} disabled={index === 0}>↑</button><button className="secondary compact" onClick={() => moveSection(index, 1)} disabled={index === activeService.formSections.length - 1}>↓</button></div>
                              </div>
                              <ol>{section.fieldIds.map((fieldId) => {
                                const field = activeService.analysis.fields.find((item) => item.id === fieldId);
                                return field ? <li key={fieldId}><strong>{field.name}</strong><span>{TYPE_OPTIONS.find(([type]) => type === field.jiraType)?.[1]}</span>{field.required && <em>Required</em>}</li> : null;
                              })}</ol>
                            </article>
                          ))}
                        </div>
                        <h3>Inferred visibility rules</h3>
                        <div className="conditionList">
                          {activeService.proposedConditions.map((condition) => {
                            const controller = activeService.analysis.fields.find((field) => field.id === condition.controllerFieldId);
                            const targets = condition.targetFieldIds.map((id) => activeService.analysis.fields.find((field) => field.id === id)?.name).filter(Boolean);
                            return <article className="conditionCard" key={condition.id}><span className="proposalBadge">Inferred</span><p><strong>If</strong> {controller?.name} = {condition.value}</p><p><strong>Show</strong> {targets.join(', ')}</p></article>;
                          })}
                        </div>
                      </section>
                    )}

                    {serviceView === 'workflow' && (
                      <section className="panel">
                        <div className="row">
                          <div>
                            <h2>Workflow Migration Engine</h2>
                            <p className="hint">v6.0 separates source evidence, a buildable Jira workflow model, and manual-review items. It does not invent missing Ivanti workflow logic.</p>
                          </div>
                          <label className="compactLabel">Show<select value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value as 'all' | WorkflowCategory)}><option value="all">All evidence</option>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}s</option>)}</select></label>
                        </div>

                        <div className="reportMetrics">
                          <div><strong>{activeService.analysis.workflowMigration.statuses.length}</strong><span>Explicit statuses</span></div>
                          <div><strong>{activeService.analysis.workflowMigration.transitions.filter((item) => item.fromStatus && item.toStatus).length}</strong><span>Buildable transitions</span></div>
                          <div><strong>{activeService.analysis.workflowMigration.approvals.length}</strong><span>Approvals</span></div>
                          <div><strong>{activeService.analysis.workflowMigration.reviewItems.length}</strong><span>Review items</span></div>
                          <div><strong>{activeService.analysis.workflowMigration.confidence}%</strong><span>Source confidence</span></div>
                        </div>

                        {activeService.analysis.workflowMigration.statuses.length > 0 && (
                          <>
                            <h3>Detected Ivanti statuses</h3>
                            <div className="statusFlow">
                              {activeService.analysis.workflowMigration.statuses.map((status, index) => (
                                <div className="statusStep" key={status.id}>
                                  <span>{status.name}</span>
                                  <small>{status.statusCategory} · {status.confidence}%</small>
                                  {index < activeService.analysis.workflowMigration.statuses.length - 1 && <b>→</b>}
                                </div>
                              ))}
                            </div>
                          </>
                        )}

                        {activeService.analysis.workflowMigration.transitions.length > 0 && (
                          <>
                            <h3>Detected transitions</h3>
                            <div className="workflowList">
                              {activeService.analysis.workflowMigration.transitions.map((transition) => (
                                <article className={`workflowItem ${transition.fromStatus && transition.toStatus ? 'transition' : 'condition'}`} key={transition.id}>
                                  <span className="sequence">{transition.confidence}%</span>
                                  <div>
                                    <strong>{transition.name}</strong>
                                    <span className="categoryBadge">{transition.fromStatus && transition.toStatus ? 'Buildable' : 'Review'}</span>
                                    <p>{transition.fromStatus || 'Unknown source'} → {transition.toStatus || 'Unknown target'}</p>
                                    {transition.condition && <p>Source condition: {transition.condition}</p>}
                                    {transition.assignment && <p>Assignment: {transition.assignment}</p>}
                                    {transition.reviewReason && <p className="hint">{transition.reviewReason}</p>}
                                  </div>
                                </article>
                              ))}
                            </div>
                          </>
                        )}

                        {activeService.analysis.workflowMigration.reviewItems.length > 0 && (
                          <div className="conflictPanel">
                            <h3>Manual review boundary</h3>
                            <p className="hint">These items are deliberately not guessed by the migration engine.</p>
                            {activeService.analysis.workflowMigration.reviewItems.map((item, index) => <article key={index}><p>{item}</p></article>)}
                          </div>
                        )}

                        {activeService.analysis.workflowMigration.canBuild ? (
                          <div className="projectBuildActions">
                            <article className="buildCard ready">
                              <div><strong>1. Dry-run against Jira</strong><p>Uses Jira's workflow-create validation endpoint. No Jira configuration is changed.</p></div>
                              <button disabled={workflowEngineBusy} onClick={() => validateWorkflowEngine(activeService)}>{workflowEngineBusy ? 'Validating…' : 'Validate workflow'}</button>
                            </article>
                            <article className="buildCard liveStructure">
                              <div><strong>2. Create versioned workflow</strong><p>Creates <strong>{activeService.analysis.serviceName} - Ivanti Workflow v6</strong> after Jira validation. Existing live workflows are never overwritten silently.</p></div>
                              <button disabled={workflowEngineBusy} onClick={() => createWorkflowEngine(activeService)}>{workflowEngineBusy ? 'Creating…' : 'Create v6 workflow'}</button>
                            </article>
                          </div>
                        ) : (
                          <div className="emptyState proposedWorkflow">
                            <strong>No safely buildable Ivanti workflow graph was found in this export</strong>
                            <p>v6.0 requires at least two explicit statuses and one transition with both source and target statuses. Upload an Ivanti export that contains workflow/process metadata to test the migration engine.</p>
                            <p className="hint">The older recommended workflow remains available as a planning fallback, but v6.0 will not present inferred statuses as if they were source workflow metadata.</p>
                          </div>
                        )}

                        {workflowEngineResults[activeService.id] && (
                          <section className="structureResults">
                            <div className="row">
                              <div><h3>Workflow engine result</h3><p className="hint">{workflowEngineResults[activeService.id].mode === 'validate' ? 'Dry-run only — Jira was not changed.' : 'Versioned Jira workflow operation.'}</p></div>
                              <span className={`structureState ${workflowEngineResults[activeService.id].status}`}>{workflowEngineResults[activeService.id].status}</span>
                            </div>
                            <div className="structureSteps">
                              <article className={workflowEngineResults[activeService.id].status === 'failed' ? 'failed' : 'created'}>
                                <strong>{workflowEngineResults[activeService.id].workflowName}</strong>
                                <span>{workflowEngineResults[activeService.id].mode}</span>
                                {workflowEngineResults[activeService.id].workflowId && <code>{workflowEngineResults[activeService.id].workflowId}</code>}
                                <p>{workflowEngineResults[activeService.id].message}</p>
                                <small>{workflowEngineResults[activeService.id].statusCount} statuses · {workflowEngineResults[activeService.id].transitionCount} transitions</small>
                              </article>
                            </div>
                          </section>
                        )}

                        <h3>Raw workflow evidence</h3>
                        {filteredWorkflow.length ? <div className="workflowList">{filteredWorkflow.map((item) => <article className={`workflowItem ${item.category}`} key={item.id}><span className="sequence">{item.sequence}</span><div><strong>{item.label}</strong><span className="categoryBadge">{CATEGORY_LABELS[item.category]}</span>{item.assignment && <p>Assignment: {item.assignment}</p>}{item.condition && <p>Condition: {item.condition}</p>}</div></article>)}</div> : <p className="hint">No generic workflow/activity labels were detected in this export.</p>}
                      </section>
                    )}

                    {serviceView === 'automation' && (
                      <section className="panel">
                        <div className="row">
                          <div>
                            <h2>Automation Migration Engine</h2>
                            <p className="hint">Converts Ivanti workflow activities into reviewable Jira Automation candidates without pretending unsupported direct Forge rule creation is available.</p>
                          </div>
                          <button onClick={() => exportAutomationPack(activeService)}>Export automation pack</button>
                        </div>

                        {(() => {
                          const pack = automationMigrationPack(activeService);
                          return (
                            <>
                              <div className="reportMetrics">
                                <div><strong>{pack.summary.total}</strong><span>Candidates</span></div>
                                <div><strong>{pack.summary.ready}</strong><span>Already handled</span></div>
                                <div><strong>{pack.summary.review}</strong><span>Review</span></div>
                                <div><strong>{pack.summary.manual}</strong><span>Manual design</span></div>
                              </div>

                              <div className="orchestratorNotice">
                                <strong>Automation API boundary:</strong> Atlassian now documents Automation Rule Management APIs for creating and updating rules, but those resources explicitly state that Forge and OAuth2 apps cannot access them. v6.1 therefore produces a transparent migration pack for review/import rather than storing credentials or using unsupported private endpoints.
                              </div>

                              {pack.candidates.length ? (
                                <div className="automationList">
                                  {pack.candidates.map((candidate) => (
                                    <article key={candidate.id} className={`automationCandidate ${candidate.status}`}>
                                      <div className="automationHeading">
                                        <div>
                                          <strong>{candidate.name}</strong>
                                          <span className="categoryBadge">{candidate.source}</span>
                                        </div>
                                        <span className={`automationState ${candidate.status}`}>{candidate.status}</span>
                                      </div>
                                      <p><strong>Trigger:</strong> {candidate.trigger}</p>
                                      {!!candidate.conditions.length && (
                                        <div><strong>Conditions</strong><ul>{candidate.conditions.map((condition, index) => <li key={index}>{condition}</li>)}</ul></div>
                                      )}
                                      <div><strong>Actions</strong><ul>{candidate.actions.map((action, index) => <li key={index}>{action}</li>)}</ul></div>
                                      <div className="confidenceLine"><span>Confidence</span><strong>{candidate.confidence}%</strong></div>
                                      {candidate.reviewReason && <p className="hint"><strong>Review:</strong> {candidate.reviewReason}</p>}
                                    </article>
                                  ))}
                                </div>
                              ) : (
                                <div className="emptyState">
                                  <strong>No automation candidates were detected in this export</strong>
                                  <p>This is expected when the Request Offering file contains form configuration but no workflow/business-rule activities. The Workflow XML you are waiting for may provide the notification, assignment, approval and condition evidence needed here.</p>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </section>
                    )}

                    {serviceView === 'validation' && (() => {
                      const validation = validationFor(activeService);
                      return (
                        <section className="panel validationPanel">
                          <div className="row"><div><p className="eyebrow dark">Migration Test Centre</p><h2>Source → Jira validation</h2><p className="hint">Evidence-based comparison of the imported Ivanti service and the Jira configuration built in this session.</p></div><button className="secondary" onClick={() => exportValidationReport(activeService)}>Export validation report</button></div>
                          <div className="validationHero"><div><strong>{validation.score}%</strong><span>verified</span></div><div><h3>{validation.classification}</h3><p>{validation.failures} failures · {validation.blockers} source-data blockers · {validation.warnings} warnings</p></div></div>
                          <div className="validationGrid">
                            {validation.items.map(item => <article key={item.key} className={`validationCard ${item.status}`}><div className="validationCardTop"><strong>{item.label}</strong><span>{item.status}</span></div><div className="compareLine"><span>Ivanti <b>{item.source}</b></span><span>Jira <b>{item.jira}</b></span></div><p>{item.message}</p></article>)}
                          </div>
                          {!manualPortalComplete[activeService.id] && !jsmPortalResults[activeService.id]?.visibleInPortal && <div className="manualAction"><div><strong>Manual action: portal group</strong><p>After assigning the request type to a portal group in Project settings, record the step here.</p></div><button onClick={() => setManualPortalComplete(c=>({...c,[activeService.id]:true}))}>Mark complete</button></div>}
                          <div className="signoffBox"><div><strong>Migration sign-off</strong><p>Track the service from technical validation through cutover approval.</p></div><select value={validation.signoff} onChange={e=>setValidationSignoff(c=>({...c,[activeService.id]:e.target.value as 'not-tested'|'testing'|'passed'|'approved'}))}><option value="not-tested">Not tested</option><option value="testing">Testing</option><option value="passed">Passed</option><option value="approved">Approved for cutover</option></select></div>
                        </section>
                      );
                    })()}

                    {serviceView === 'create' && (
                      <section className="panel">
                        <h2>Create service configuration</h2>
                        <div className="buildCards">
                          <article className="buildCard ready"><div><strong>Native Jira fields</strong><p>Create selected fields, contexts and options now.</p></div><button disabled={!selectedCount || busy} onClick={createFields}>{busy ? 'Creating…' : 'Create fields'}</button></article>
                          <article className="buildCard liveStructure"><div><strong>JSM request type + Form + portal</strong><p>Create/reuse the request type, build the {activeService.formSections.length}-section Form with {activeService.proposedConditions.length} conditions, publish it to the request type and verify portal availability.</p></div><button disabled={jsmBusy || !structureResults[activeService.id]?.issueTypeId || !migration.targetProjectId} onClick={() => buildJsmExperience(activeService)}>{jsmBusy ? 'Building JSM…' : 'Build JSM experience'}</button></article>
                          <article className="buildCard liveStructure">
                            <div>
                              <strong>Jira issue type and workflow</strong>
                              <p>Create or reuse an issue type, workflow, statuses, transitions and an inactive workflow scheme.</p>
                            </div>
                            <button disabled={structureBusy} onClick={() => createJiraStructure(activeService)}>
                              {structureBusy ? 'Creating…' : 'Create Jira structure'}
                            </button>
                          </article>
                          <article className="buildCard liveStructure">
                            <div>
                              <strong>Activate in target project</strong>
                              <p>Assign the created workflow scheme to the company-managed project selected in Settings. Jira only allows direct assignment when the project has no issues.</p>
                            </div>
                            <button
                              disabled={activationBusy || !structureResults[activeService.id]?.workflowSchemeId || !migration.targetProjectId}
                              onClick={() => assignWorkflowScheme(activeService)}
                            >
                              {activationBusy ? 'Assigning…' : 'Assign to target project'}
                            </button>
                          </article>
                          <article className="buildCard liveStructure">
                            <div><strong>Jira screens</strong><p>Create or reuse Create, Edit and View screens, add the migrated fields, and build the screen schemes.</p></div>
                            <button disabled={screenBusy || !structureResults[activeService.id]?.issueTypeId} onClick={() => createScreenStructure(activeService)}>{screenBusy ? 'Creating…' : 'Create Jira screens'}</button>
                          </article>
                          <article className="buildCard liveStructure">
                            <div><strong>Activate screens in target project</strong><p>Assign the issue type screen scheme to the company-managed project selected in Settings.</p></div>
                            <button disabled={screenActivationBusy || !screenResults[activeService.id]?.issueTypeScreenSchemeId || !migration.targetProjectId} onClick={() => assignScreenScheme(activeService)}>{screenActivationBusy ? 'Assigning…' : 'Assign screen scheme'}</button>
                          </article>
                          
                          <article className="buildCard blueprint"><div><strong>Automation</strong><p>{automationBlueprint(activeService).length} proposed rules.</p></div><button className="secondary" onClick={() => exportServiceBlueprint(activeService)}>Export blueprint</button></article>
                        </div>
                        {structureResults[activeService.id] && (
                          <section className="structureResults">
                            <div className="row">
                              <div><h3>Jira structure results</h3><p className="hint">These are real Jira configuration operations.</p></div>
                              <span className={`structureState ${structureResults[activeService.id].status}`}>
                                {structureResults[activeService.id].status}
                              </span>
                            </div>
                            <div className="structureSteps">
                              {structureResults[activeService.id].steps.map((step, index) => (
                                <article key={`${step.element}-${index}`} className={step.status}>
                                  <strong>{step.element === 'issueType' ? 'Issue type' : step.element === 'workflow' ? 'Workflow' : 'Workflow scheme'}</strong>
                                  <span>{step.status}</span>
                                  {step.id && <code>{step.id}</code>}
                                  <p>{step.message}</p>
                                </article>
                              ))}
                            </div>
                          </section>
                        )}
                        {screenResults[activeService.id] && (
                          <section className="structureResults">
                            <div className="row"><div><h3>Screen builder results</h3><p className="hint">Create, Edit and View screens and their schemes.</p></div><span className={`structureState ${screenResults[activeService.id].status}`}>{screenResults[activeService.id].status}</span></div>
                            <div className="structureSteps">{screenResults[activeService.id].steps.map((step, index) => (
                              <article key={`${step.element}-${index}`} className={step.status}><strong>{step.element.replace(/([A-Z])/g, ' $1')}</strong><span>{step.status}</span>{step.id && <code>{step.id}</code>}<p>{step.message}</p></article>
                            ))}</div>
                          </section>
                        )}
                        {screenActivationResults[activeService.id] && (
                          <section className="structureResults"><div className="row"><div><h3>Screen activation</h3></div><span className="structureState created">assigned</span></div><div className="structureSteps"><article className="created"><strong>Issue type screen scheme</strong><span>assigned</span><code>{screenActivationResults[activeService.id].issueTypeScreenSchemeId}</code><p>{screenActivationResults[activeService.id].message}</p></article></div></section>
                        )}
                        {jsmRequestResults[activeService.id] && (
                          <section className="structureResults">
                            <div className="row"><div><h3>JSM experience results</h3><p className="hint">Request type, Form publication and portal verification.</p></div><span className={`structureState ${jsmPortalResults[activeService.id]?.status === 'verified' ? 'created' : 'partial'}`}>{jsmPortalResults[activeService.id]?.status || 'building'}</span></div>
                            <div className="structureSteps">
                              <article className={jsmRequestResults[activeService.id].status === 'created' ? 'created' : 'reused'}>
                                <strong>Request type</strong><span>{jsmRequestResults[activeService.id].status}</span><code>{jsmRequestResults[activeService.id].requestTypeId}</code>
                                <p>{jsmRequestResults[activeService.id].message}</p>
                                {(jsmRequestResults[activeService.id].duplicates?.length ?? 0) > 0 && (
                                  <div className="inlineActions">
                                    <span>{jsmRequestResults[activeService.id].duplicates?.length} duplicate request type(s) detected.</span>
                                    <button disabled={jsmBusy} onClick={() => removeDuplicateRequestTypes(activeService)}>Remove duplicates</button>
                                  </div>
                                )}
                              </article>
                              {jsmFormResults[activeService.id] && <>
                                <article className={jsmFormResults[activeService.id].status === 'created' ? 'created' : jsmFormResults[activeService.id].status === 'reused' ? 'reused' : 'partial'}><strong>JSM Form</strong><span>{jsmFormResults[activeService.id].status}</span>{jsmFormResults[activeService.id].formId && <code>{jsmFormResults[activeService.id].formId}</code>}<p>{jsmFormResults[activeService.id].message} Resolved {jsmFormResults[activeService.id].resolvedFields}/{jsmFormResults[activeService.id].totalFields} Jira fields.</p></article>
                                {jsmFormResults[activeService.id].stages.map((stage, index) => <article key={`${stage.key}-${index}`} className={stage.status === 'failed' ? 'failed' : stage.status === 'partial' || stage.status === 'skipped' ? 'partial' : stage.status === 'created' ? 'created' : 'reused'}><strong>{stage.key.replace(/([A-Z])/g, ' $1')}</strong><span>{stage.status}</span><p>{stage.message}</p>{stage.detail !== undefined && <pre className="apiDetail">{JSON.stringify(stage.detail, null, 2)}</pre>}</article>)}
                              </>}
                              {jsmPortalResults[activeService.id] && <article className={jsmPortalResults[activeService.id].status === 'verified' ? 'created' : 'partial'}>
                                <strong>Final JSM validation</strong><span>{jsmPortalResults[activeService.id].status}</span>
                                <p>{jsmPortalResults[activeService.id].message}</p>
                                {!jsmPortalResults[activeService.id].visibleInPortal && (jsmPortalResults[activeService.id].portalGroups?.length ?? 0) > 0 && (
                                  <p className="hint"><strong>Portal group step:</strong> In Project settings → Request types, add this request type to one of: {jsmPortalResults[activeService.id].portalGroups?.map((group) => group.name).join(', ')}.</p>
                                )}
                              </article>}
                            </div>
                          </section>
                        )}
                        {activationResults[activeService.id] && (
                          <section className="structureResults">
                            <div className="row"><div><h3>Project activation</h3><p className="hint">The workflow scheme is now associated with the selected Jira project.</p></div><span className="structureState created">assigned</span></div>
                            <div className="structureSteps"><article className="created"><strong>Target project</strong><span>assigned</span><code>{activationResults[activeService.id].projectId}</code><p>{activationResults[activeService.id].message}</p></article></div>
                          </section>
                        )}
                        <div className="notice"><strong>v6.1 Workflow + Automation Migration:</strong> workflow evidence can be validated and built as versioned Jira configuration, while notifications, assignments, approvals and conditions are converted into transparent Automation candidates for review. Direct Automation REST creation remains disabled because Atlassian currently blocks Forge/OAuth2 app access to those rule-management resources.</div>
                      </section>
                    )}
                  </section>
                )}
              </div>
            )}
          </>
        )}

        {mainView === 'shared-fields' && (
          <section className="panel fullPanel">
            <h1>Shared fields</h1>
            <p className="hint">The preflight groups mapped Jira names across every imported service.</p>
            <div className="tableWrap">
              <table className="sharedTable">
                <thead><tr><th>Jira field</th><th>Type</th><th>Used by</th><th>Combined options</th><th>Preflight</th></tr></thead>
                <tbody>{sharedFields.map((field) => <tr key={field.name.toLowerCase()}><td><strong>{field.name}</strong></td><td>{field.types.map((type) => TYPE_OPTIONS.find(([value]) => value === type)?.[1]).join(', ')}</td><td>{field.services.length}<small>{field.services.join(', ')}</small></td><td>{field.options.length ? field.options.join(', ') : '—'}</td><td>{field.types.length > 1 ? <span className="conflictBadge">Conflict</span> : <span className="okBadge">Ready</span>}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
        )}

        {mainView === 'build' && (
          <section className="panel fullPanel">
            <div className="row">
              <div><h1>Create in Jira</h1><p className="hint">Run preflight first. v1.0 creates one deduplicated set of native Jira fields across all imported services.</p></div>
              <div className="actions"><button className="secondary" onClick={() => selectAllAcrossProject(true)}>Select all fields</button><button className="secondary" onClick={() => selectAllAcrossProject(false)}>Clear all</button></div>
            </div>

            <div className="reportMetrics">
              <div><strong>{buildPlan.uniqueFields}</strong><span>Unique fields</span></div>
              <div><strong>{buildPlan.selectedFields}</strong><span>Selected unique fields</span></div>
              <div><strong>{buildPlan.conflicts.length}</strong><span>Type conflicts</span></div>
              <div><strong>{buildPlan.servicesReady}</strong><span>Services ready</span></div>
              <div><strong>{buildPlan.servicesNeedingReview}</strong><span>Need review</span></div>
            </div>

            {buildPlan.conflicts.length ? (
              <div className="conflictPanel">
                <h2>Resolve these conflicts first</h2>
                {buildPlan.conflicts.map((conflict) => <article key={conflict.fieldName}><strong>{conflict.fieldName}</strong><p>{conflict.reason}</p><small>Types: {conflict.types.join(', ')} · Services: {conflict.serviceNames.join(', ')}</small></article>)}
              </div>
            ) : (
              <div className="preflightSuccess"><strong>Preflight passed</strong><p>No duplicate-name field-type conflicts were found.</p></div>
            )}

            <div className="projectBuildActions">
              <article className="buildCard ready">
                <div><strong>1. Create unique Jira fields</strong><p>Creates or reuses each selected field once, including contexts and options.</p></div>
                <button disabled={bulkBusy || !!buildPlan.conflicts.length || !buildPlan.selectedFields} onClick={bulkCreateUniqueFields}>{bulkBusy ? 'Creating…' : 'Create project fields'}</button>
              </article>
              <article className="buildCard blueprint">
                <div><strong>2. Export complete implementation pack</strong><p>Includes Forms, request types, workflow and automation blueprints for every service.</p></div>
                <button className="secondary" disabled={!migration.services.length} onClick={exportProject}>Export implementation pack</button>
              </article>
            </div>
          </section>
        )}


        {mainView === 'orchestrator' && (
          <section className="panel fullPanel">
            <div className="row">
              <div>
                <h1>Migration wizard</h1>
                <p className="hint">Compare the target Jira site, migrate supported configuration, retry temporary failures, and resume safely.</p>
              </div>
              <div className="actions">
                <button className="secondary" onClick={compareExistingFields} disabled={orchestrationRunning}>Compare Jira</button>
                {checkpoint && <button className="secondary" onClick={() => runOrchestrator(true)} disabled={orchestrationRunning}>Resume migration</button>}
                <button disabled={orchestrationRunning || !migration.services.length || !!conflicts.length} onClick={() => runOrchestrator(false)}>
                  {orchestrationRunning ? 'Running…' : 'Start migration'}
                </button>
              </div>
            </div>

            <div className="wizardProgress">
              <div className="wizardProgressBar"><i style={{ width: `${Math.round((orchestrationStep / orchestrationSteps.length) * 100)}%` }} /></div>
              <strong>{Math.round((orchestrationStep / orchestrationSteps.length) * 100)}%</strong>
            </div>

            <div className="orchestratorNotice">
              <strong>Migration boundary:</strong> fields, contexts and options run live. Forms, request types, workflows and automation remain reviewable blueprints.
            </div>

            <div className="orchestrationList">
              {orchestrationSteps.map((step, index) => {
                const done = checkpoint?.completedStepKeys.includes(step.key) || orchestrationStep > index;
                const active = orchestrationRunning && orchestrationStep === index + 1;
                return (
                  <article key={step.key} className={`${done ? 'done' : ''} ${active ? 'active' : ''}`}>
                    <span>{done ? '✓' : index + 1}</span>
                    <div><strong>{step.label}</strong><p>{step.mode === 'live' ? 'Runs against Jira or exports a report.' : 'Generates a configuration blueprint.'}</p></div>
                    <em>{step.mode === 'live' ? 'Live' : 'Blueprint'}</em>
                  </article>
                );
              })}
            </div>

            {!!existingComparison.length && (
              <section className="comparisonPanel">
                <div className="row">
                  <div>
                    <h2>Jira comparison results</h2>
                    <p className="hint">Review what will be reused and what needs to be created before starting the migration.</p>
                  </div>
                  <span className="comparisonHealth">
                    {existingComparison.filter((item) => item.status === 'review').length === 0 ? 'Ready to migrate' : 'Review required'}
                  </span>
                </div>
                <div className="comparisonSummary">
                  <span><strong>{existingComparison.length}</strong> checked</span>
                  <span><strong>{existingComparison.filter((item) => item.status === 'reuse').length}</strong> reusable</span>
                  <span><strong>{existingComparison.filter((item) => item.status === 'new').length}</strong> new</span>
                  <span><strong>{existingComparison.filter((item) => item.status === 'review').length}</strong> review</span>
                </div>
                <div className="comparisonTableWrap">
                  <table className="comparisonTable">
                    <thead>
                      <tr><th>Proposed Jira field</th><th>Proposed type</th><th>Status</th><th>Existing Jira field</th></tr>
                    </thead>
                    <tbody>
                      {existingComparison.map((item) => (
                        <tr key={item.name}>
                          <td><strong>{item.name}</strong></td>
                          <td>{TYPE_OPTIONS.find(([type]) => type === item.proposedType)?.[1] || item.proposedType}</td>
                          <td><span className={`comparisonStatus ${item.status}`}>{item.status === 'reuse' ? 'Reuse' : item.status === 'new' ? 'Create' : 'Review'}</span></td>
                          <td>{item.existingId ? <><code>{item.existingId}</code><small>{item.existingType}</small></> : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {!!intelligentMappings.length && (
              <section className="intelligentBuilder">
                <div className="row">
                  <div>
                    <h2>Intelligent field builder</h2>
                    <p className="hint">Review each recommendation. You can create, reuse, merge options, or skip.</p>
                  </div>
                  <button disabled={bulkBusy} onClick={applyIntelligentMappings}>
                    {bulkBusy ? 'Applying…' : 'Apply field decisions'}
                  </button>
                </div>

                <div className="builderSummary">
                  <span><strong>{intelligentMappings.filter((item) => item.action === 'create').length}</strong> create</span>
                  <span><strong>{intelligentMappings.filter((item) => item.action === 'reuse').length}</strong> reuse</span>
                  <span><strong>{intelligentMappings.filter((item) => item.action === 'merge').length}</strong> merge</span>
                  <span><strong>{intelligentMappings.filter((item) => item.action === 'skip').length}</strong> skip</span>
                </div>

                <div className="mappingCards">
                  {intelligentMappings.map((mapping) => (
                    <article key={mapping.key} className={`mappingCard ${mapping.action}`}>
                      <div className="mappingMain">
                        <strong>{mapping.proposedName}</strong>
                        <small>{TYPE_OPTIONS.find(([type]) => type === mapping.proposedType)?.[1] || mapping.proposedType}</small>
                        <p>{mapping.reason}</p>
                      </div>
                      <div className="mappingCandidate">
                        <label>Existing Jira field
                          <select
                            value={mapping.existingFieldId || ''}
                            onChange={(event) => {
                              const selected = existingJiraFields.find((field) => field.id === event.target.value);
                              updateIntelligentMapping(mapping.key, {
                                existingFieldId: selected?.id,
                                existingFieldName: selected?.name,
                                existingType: selected?.schema?.custom || selected?.schema?.type,
                                confidence: selected ? similarity(mapping.proposedName, selected.name) : 95
                              });
                            }}
                          >
                            <option value="">No existing field</option>
                            {existingJiraFields.map((field) => (
                              <option key={field.id} value={field.id}>{field.name} ({field.id})</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="mappingAction">
                        <label>Action
                          <select
                            value={mapping.action}
                            onChange={(event) => updateIntelligentMapping(mapping.key, { action: event.target.value as MappingAction })}
                          >
                            <option value="create">Create new</option>
                            <option value="reuse" disabled={!mapping.existingFieldId}>Reuse existing</option>
                            <option value="merge" disabled={!mapping.existingFieldId || !['select','checkbox'].includes(mapping.proposedType)}>Reuse + merge options</option>
                            <option value="skip">Skip</option>
                          </select>
                        </label>
                      </div>
                      <div className="confidence">
                        <strong>{mapping.confidence}%</strong>
                        <span>confidence</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="liveLog">
              <div className="row">
                <div><h2>Live build log</h2><p className="hint">Progress, retries and failures appear here.</p></div>
                <button className="secondary" onClick={() => setBuildLogs([])}>Clear log</button>
              </div>
              {buildLogs.length ? (
                <div className="logList">
                  {buildLogs.map((entry) => (
                    <article key={entry.id} className={entry.level}>
                      <time>{entry.timestamp}</time><strong>{entry.step}</strong><span>{entry.message}</span>
                    </article>
                  ))}
                </div>
              ) : <div className="emptyState"><strong>No migration activity yet</strong><p>Compare Jira or start the migration.</p></div>}
            </section>

            {(migrationResult.created + migrationResult.reused + migrationResult.partial + migrationResult.failed) > 0 && (
              <section className="migrationCompletion">
                <div className="row">
                  <div><h2>Migration result</h2><p className="hint">Latest field build results and prepared blueprint totals.</p></div>
                  <span className={migrationResult.failed ? 'resultState review' : 'resultState complete'}>
                    {migrationResult.failed ? 'Completed with issues' : 'Migration steps complete'}
                  </span>
                </div>
                <div className="completionMetrics">
                  <article><strong>{migrationResult.created}</strong><span>Fields created</span></article>
                  <article><strong>{migrationResult.reused}</strong><span>Fields reused</span></article>
                  <article><strong>{migrationResult.partial}</strong><span>Partially completed</span></article>
                  <article><strong>{migrationResult.failed}</strong><span>Failed</span></article>
                  <article><strong>{migrationResult.formsPrepared}</strong><span>Forms prepared</span></article>
                  <article><strong>{migrationResult.conditionsPrepared}</strong><span>Conditions prepared</span></article>
                  <article><strong>{migrationResult.workflowsPrepared}</strong><span>Workflow blueprints</span></article>
                  <article><strong>{migrationResult.automationPrepared}</strong><span>Automation rules</span></article>
                </div>
              </section>
            )}

            {checkpoint && (
              <div className="checkpointBar">
                <div><strong>Migration checkpoint available</strong><p>Saved {new Date(checkpoint.updatedAt).toLocaleString()}.</p></div>
                <button className="secondary" onClick={clearCheckpoint}>Clear checkpoint</button>
              </div>
            )}
          </section>
        )}

        {mainView === 'report' && (
          <section className="panel fullPanel">
            <div className="row"><div><h1>Migration report</h1><p className="hint">A management-friendly summary of migration progress and outstanding review work.</p></div><div className="actions"><button className="secondary" onClick={exportFieldMappingCsv}>Export field mapping CSV</button><button className="secondary" onClick={exportImplementationChecklistCsv}>Export checklist CSV</button></div></div>
            <div className="reportMetrics">
              <div><strong>{migration.services.length}</strong><span>Services imported</span></div>
              <div><strong>{overall.totalFields}</strong><span>Field references</span></div>
              <div><strong>{sharedFields.length}</strong><span>Unique Jira fields</span></div>
              <div><strong>{overall.created}</strong><span>Fields created/reused</span></div>
              <div><strong>{overall.review}</strong><span>Workflows needing review</span></div>
            </div>
            <div className="reportList">
              {migration.services.map((service) => <article key={service.id}><div><strong>{service.analysis.serviceName}</strong><p>{service.analysis.fields.length} fields · {service.formSections.length} sections · {automationBlueprint(service).length} automation rules</p></div><span>{serviceReadiness(service)}%</span></article>)}
            </div>
          </section>
        )}


        {mainView === 'validation' && (
          <section className="panel fullPanel validationPanel">
            <div className="row"><div><p className="eyebrow dark">Migration assurance</p><h1>Test & Validation Centre</h1><p className="hint">See which services are ready, blocked by source data, or still need Jira/manual verification.</p></div></div>
            <div className="reportMetrics">
              <div><strong>{migration.services.filter(s=>validationFor(s).failures===0 && validationFor(s).blockers===0 && validationFor(s).warnings===0).length}</strong><span>Ready for testing</span></div>
              <div><strong>{migration.services.filter(s=>validationFor(s).blockers>0).length}</strong><span>Source-data blocked</span></div>
              <div><strong>{migration.services.reduce((n,s)=>n+validationFor(s).failures,0)}</strong><span>Validation failures</span></div>
              <div><strong>{migration.services.reduce((n,s)=>n+validationFor(s).warnings,0)}</strong><span>Warnings/manual steps</span></div>
            </div>
            <div className="validationServiceList">{migration.services.map(service=>{const v=validationFor(service); return <article key={service.id}><div><strong>{service.analysis.serviceName}</strong><p>{v.classification} · {v.failures} failures · {v.blockers} blockers · {v.warnings} warnings</p></div><div className="validationServiceActions"><span>{v.score}%</span><button className="secondary" onClick={()=>{setActiveServiceId(service.id);setMainView('services');setServiceView('validation')}}>Open validation</button></div></article>})}</div>
            {!migration.services.length && <div className="emptyState"><strong>No services imported</strong><p>Import an Ivanti service to start validation.</p></div>}
          </section>
        )}

        {mainView === 'health' && (
          <section className="panel fullPanel healthPage">
            <div className="row">
              <div>
                <p className="eyebrow dark">Environment readiness</p>
                <h1>Migration health check</h1>
                <p className="hint">Verify Jira permissions, workflow access and target-project compatibility before creating configuration.</p>
              </div>
              <button onClick={runEnvironmentHealthCheck} disabled={healthBusy}>{healthBusy ? 'Checking…' : 'Run health check'}</button>
            </div>
            {!migration.targetProjectId && <div className="notice"><strong>Target project required:</strong> choose one in Settings before running the full check.</div>}
            {healthResult && (
              <>
                <div className={`healthSummary ${healthResult.ready ? 'ready' : 'blocked'}`}>
                  <strong>{healthResult.ready ? 'Ready to build' : 'Action required'}</strong>
                  <span>Checked {new Date(healthResult.checkedAt).toLocaleString()}</span>
                </div>
                <div className="healthGrid">
                  {healthResult.checks.map((check) => (
                    <article key={check.key} className={`healthCard ${check.status}`}>
                      <div className="healthIcon">{check.status === 'pass' ? '✓' : check.status === 'warning' ? '!' : '×'}</div>
                      <div><strong>{check.label}</strong><p>{check.message}</p></div>
                    </article>
                  ))}
                </div>
              </>
            )}
            {!healthResult && <div className="emptyState"><strong>No health check run yet</strong><p>Run the check before your next Jira structure build.</p></div>}
          </section>
        )}

        {mainView === 'settings' && (
          <section className="panel fullPanel">
            <h1>Migration settings</h1>
            <label>Target Jira project<select value={migration.targetProjectId} onChange={(event) => updateMigration({ targetProjectId: event.target.value })}><option value="">Choose a project</option>{jiraProjects.map((project) => <option key={project.id} value={project.id}>{project.name} ({project.key})</option>)}</select></label>
            <div className="settingsActions"><button onClick={saveProject}>Save project</button><button className="secondary" onClick={loadProject}>Load saved project</button><button className="secondary" onClick={exportProject} disabled={!migration.services.length}>Export implementation pack</button></div>
            <div className="notice"><strong>Storage:</strong> v1.0 stores the migration project in this browser. The generated implementation pack is portable JSON.</div>
          </section>
        )}
      </section>
    </main>
  );
}
