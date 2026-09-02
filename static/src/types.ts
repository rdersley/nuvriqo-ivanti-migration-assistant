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

export type ExistingFieldComparison = {
  name: string;
  proposedType: JiraFieldType;
  status: 'new' | 'reuse' | 'review';
  existingId?: string;
  existingType?: string;
  reason?: string;
};


export type MappingAction = 'create' | 'reuse' | 'merge' | 'skip';

export type IntelligentFieldMapping = {
  key: string;
  serviceId: string;
  sourceFieldId: string;
  ivantiName: string;
  proposedName: string;
  proposedType: JiraFieldType;
  options: string[];
  action: MappingAction;
  existingFieldId?: string;
  existingFieldName?: string;
  existingType?: string;
  confidence: number;
  reason: string;
};


export type JiraStructureStep = {
  element: 'issueType' | 'workflow' | 'workflowScheme';
  status: 'created' | 'reused' | 'failed' | 'skipped';
  id?: string;
  name?: string;
  message: string;
};

export type JiraStructureResult = {
  serviceName: string;
  status: 'created' | 'partial' | 'failed';
  issueTypeId?: string;
  workflowId?: string;
  workflowName?: string;
  workflowSchemeId?: string;
  steps: JiraStructureStep[];
};

export type ProjectActivationResult = {
  projectId: string;
  workflowSchemeId: string;
  status: 'assigned' | 'failed';
  message: string;
};


export type HealthCheckItem = {
  key: string;
  label: string;
  status: 'pass' | 'warning' | 'fail';
  message: string;
};

export type EnvironmentHealthResult = {
  checkedAt: string;
  ready: boolean;
  project?: { id: string; key: string; name: string; projectTypeKey?: string; simplified?: boolean };
  issueCount?: number;
  checks: HealthCheckItem[];
};


export type ScreenStructureStep = {
  element: 'createScreen' | 'editScreen' | 'viewScreen' | 'screenScheme' | 'issueTypeScreenScheme' | 'fields';
  status: 'created' | 'reused' | 'partial' | 'failed' | 'skipped';
  id?: string;
  name?: string;
  message: string;
};

export type ScreenStructureResult = {
  serviceName: string;
  status: 'created' | 'partial' | 'failed';
  createScreenId?: string;
  editScreenId?: string;
  viewScreenId?: string;
  screenSchemeId?: string;
  issueTypeScreenSchemeId?: string;
  steps: ScreenStructureStep[];
};

export type ScreenActivationResult = {
  projectId: string;
  issueTypeScreenSchemeId: string;
  status: 'assigned';
  message: string;
};

export type JsmRequestTypeResult = { status: 'created' | 'reused'; serviceDeskId: string; requestTypeId: string; name: string; message: string; issueTypeId?: string; issueTypeSchemeId?: string; duplicates?: Array<{ id: string; issueTypeId?: string }> };
export type JsmFormStage = { key: 'fieldResolution' | 'baseForm' | 'questions' | 'readback' | 'conditions' | 'publish'; status: 'created' | 'reused' | 'verified' | 'partial' | 'failed' | 'skipped'; message: string; detail?: unknown };
export type JsmFormResult = { status: 'created' | 'reused' | 'partial' | 'failed'; formId: string; serviceDeskId: string; requestTypeId: string; resolvedFields: number; totalFields: number; sections: number; conditions: number; published: boolean; stages: JsmFormStage[]; message: string };
export type JsmPortalResult = {
  status: 'verified' | 'partial';
  serviceDeskId: string;
  requestTypeId: string;
  requestTypeName: string;
  issueTypeId?: string;
  issueTypeMatches?: boolean;
  formAttached: boolean;
  formId?: string;
  visibleInPortal: boolean;
  groupIds?: string[];
  portalGroups?: Array<{ id: string; name: string }>;
  message: string;
};

export type JsmDuplicateCleanupResult = {
  status: 'deleted' | 'partial';
  deleted: number;
  failed: number;
  results: Array<{ id: string; status: 'deleted' | 'failed'; message: string }>;
  message: string;
};
