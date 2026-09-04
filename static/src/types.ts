export type JiraFieldType =
  | 'text'
  | 'paragraph'
  | 'date'
  | 'select'
  | 'checkbox'
  | 'user'
  | 'number';

export type ParsedField = {
  id: string;
  ivantiName: string;
  name: string;
  description: string;
  rawType: string;
  jiraType: JiraFieldType;
  required: boolean;
  options: string[];
  selected: boolean;
};

export type WorkflowCategory =
  | 'task'
  | 'approval'
  | 'condition'
  | 'notification'
  | 'transition'
  | 'activity';

export type WorkflowItem = {
  id: string;
  label: string;
  category: WorkflowCategory;
  sourceTag: string;
  assignment?: string;
  condition?: string;
  sequence: number;
};

export type SuggestedWorkflow = {
  statuses: string[];
  taskNames: string[];
  notes: string[];
};

export type WorkflowStatusCandidate = {
  id: string;
  name: string;
  sourceTag: string;
  sourceKey?: string;
  statusCategory: 'TODO' | 'IN_PROGRESS' | 'DONE';
  confidence: number;
};

export type WorkflowTransitionCandidate = {
  id: string;
  name: string;
  sourceTag: string;
  fromStatus?: string;
  toStatus?: string;
  condition?: string;
  assignment?: string;
  confidence: number;
  reviewReason?: string;
};

export type WorkflowMigrationModel = {
  statuses: WorkflowStatusCandidate[];
  transitions: WorkflowTransitionCandidate[];
  approvals: WorkflowItem[];
  notifications: WorkflowItem[];
  reviewItems: string[];
  confidence: number;
  canBuild: boolean;
};

export type WorkflowMigrationResult = {
  mode: 'validate' | 'create';
  status: 'verified' | 'created' | 'reused' | 'partial' | 'failed';
  workflowId?: string;
  workflowName: string;
  statusCount: number;
  transitionCount: number;
  message: string;
  validation?: unknown;
};

export type AutomationCandidate = {
  id: string;
  name: string;
  source: 'notification' | 'assignment' | 'task' | 'condition' | 'approval';
  trigger: string;
  conditions: string[];
  actions: string[];
  confidence: number;
  status: 'ready' | 'review' | 'manual';
  reviewReason?: string;
};

export type AutomationMigrationPack = {
  serviceName: string;
  generatedAt: string;
  projectId: string;
  candidates: AutomationCandidate[];
  summary: {
    total: number;
    ready: number;
    review: number;
    manual: number;
  };
  jiraAutomationApi: {
    directForgeCreationSupported: false;
    reason: string;
  };
};

export type Analysis = {
  serviceName: string;
  description: string;
  fields: ParsedField[];
  workflowLabels: string[];
  workflowItems: WorkflowItem[];
  suggestedWorkflow: SuggestedWorkflow;
  workflowMigration: WorkflowMigrationModel;
  stats: {
    fields: number;
    workflowItems: number;
    tasks: number;
    approvals: number;
    conditions: number;
    notifications: number;
    xmlElements: number;
  };
};

export type Project = {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  simplified: boolean;
};

export type CreationStep = {
  step: 'field' | 'context' | 'options';
  status: 'created' | 'reused' | 'failed' | 'skipped';
  message?: string;
};

export type CreationResult = {
  name: string;
  status: 'created' | 'reused' | 'partial' | 'failed' | 'skipped';
  id?: string;
  key?: string;
  message?: string;
  ivantiName?: string;
  steps?: CreationStep[];
};

export type FormSection = {
  id: string;
  name: string;
  fieldIds: string[];
};

export type ProposedCondition = {
  id: string;
  controllerFieldId: string;
  operator: 'equals';
  value: string;
  targetFieldIds: string[];
  source: 'inferred';
};

export type IvantiWorkflowSource = {
  source: 'ivanti-workflow-export' | 'ivanti-getinstance';
  sourceFile: string;
  capturedAt: string;
  workflow: {
    name: string;
    displayName?: string;
    description?: string;
    objectType?: string;
    version?: string;
    status?: string;
    exception?: string;
    blocks: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    trigger?: Record<string, unknown>;
    quickActions?: Array<Record<string, unknown>>;
    derived?: Record<string, unknown>;
  };
};

export type ServiceBuildState = {
  fieldResults: CreationResult[];
  formCreated: boolean;
  workflowCreated: boolean;
  automationGenerated: boolean;
};

export type MigrationService = {
  id: string;
  sourceFile: string;
  importedAt: string;
  updatedAt: string;
  analysis: Analysis;
  formSections: FormSection[];
  proposedConditions: ProposedCondition[];
  ivantiWorkflows?: IvantiWorkflowSource[];
  build: ServiceBuildState;
};

export type MigrationProject = {
  schemaVersion: 2;
  name: string;
  targetProjectId: string;
  createdAt: string;
  updatedAt: string;
  services: MigrationService[];
};

export type PreflightConflict = {
  fieldName: string;
  serviceNames: string[];
  types: JiraFieldType[];
  reason: string;
};

export type BuildPlan = {
  uniqueFields: number;
  selectedFields: number;
  conflicts: PreflightConflict[];
  servicesReady: number;
  servicesNeedingReview: number;
};

export type AutomationBlueprintRule = {
  name: string;
  trigger: string;
  conditions: string[];
  actions: string[];
};

export type ServiceImplementationBlueprint = {
  serviceId: string;
  serviceName: string;
  sourceFile: string;
  requestType: {
    name: string;
    description: string;
    proposedPortalGroup: string;
  };
  form: {
    sections: FormSection[];
    conditions: ProposedCondition[];
  };
  workflow: SuggestedWorkflow;
  automation: AutomationBlueprintRule[];
};

export type BuildLogEntry = {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warning' | 'error';
  step: string;
  message: string;
};

export type BuildCheckpoint = {
  projectName: string;
  targetProjectId: string;
  completedStepKeys: string[];
  failedStepKey?: string;
  updatedAt: string;
};
