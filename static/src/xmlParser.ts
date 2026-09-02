import type {
  Analysis,
  JiraFieldType,
  ParsedField,
  SuggestedWorkflow,
  WorkflowCategory,
  WorkflowItem,
  WorkflowMigrationModel,
  WorkflowStatusCandidate,
  WorkflowTransitionCandidate
} from './types';

function textOf(node: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const found = node.querySelector(selector);
    const value = found?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function attributeOf(node: Element, names: string[]): string {
  for (const name of names) {
    const value = node.getAttribute(name);
    if (value) return value.trim();
  }
  return '';
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function cleanText(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const pieces = cleaned.split(/\s*,\s*/).filter(Boolean);
  if (pieces.length >= 5) {
    return pieces.find((piece) => /^[A-Za-z0-9][-A-Za-z0-9 '&/().:+?]{2,}$/.test(piece)) || pieces[0];
  }
  return cleaned;
}

const EXACT_TYPES: Record<string, JiraFieldType> = {
  'start date': 'date',
  'first name': 'text',
  'last name': 'text',
  'title': 'text',
  'job title': 'text',
  'department': 'select',
  'subdepartment': 'select',
  'sub department': 'select',
  'employment type': 'select',
  'location': 'select',
  'facility detail': 'text',
  'facility details': 'text',
  'hiring manager': 'user',
  'department manager': 'user',
  'hiring manager email': 'text',
  'computer required': 'checkbox',
  'computer required?': 'checkbox',
  'computer type': 'select',
  'docking station': 'checkbox',
  'docking station required': 'checkbox',
  'primary monitor': 'select',
  'second monitor requested': 'checkbox',
  'second monitor requested?': 'checkbox',
  'secondary monitor requested': 'checkbox',
  'secondary monitor requested?': 'checkbox',
  'secondary monitor': 'select',
  'keyboard and mouse': 'checkbox',
  'keyboard and mouse required': 'checkbox',
  'mobile phone required': 'checkbox',
  'mobile phone required?': 'checkbox',
  'mobile phone': 'select',
  'mobile phone type': 'select',
  'test devices': 'checkbox',
  'equipment shipping required': 'checkbox',
  'equipment shipping required?': 'checkbox',
  'employee private email address': 'text',
  'employee private email': 'text',
  'employee phone number': 'text',
  'employee address': 'paragraph',
  'employee shipping address': 'paragraph',
  'special request': 'paragraph',
  'additional information': 'paragraph',
  'additional information / special request': 'paragraph',
  'is user in servicedesk': 'checkbox',
  'service desk user': 'checkbox'
};

function inferType(raw: string, name: string): JiraFieldType {
  const exact = EXACT_TYPES[name.trim().toLowerCase()];
  if (exact) return exact;

  const value = `${raw} ${name}`.toLowerCase();
  if (/\b(date|datetime|calendar)\b/.test(value)) return 'date';
  if (/\b(manager|approver|user picker|person)\b/.test(value) && !/\bemail\b/.test(value)) return 'user';
  if (/\b(number|integer|decimal|currency|quantity)\b/.test(value)) return 'number';
  if (/\b(additional|description|address|notes?|comments?|special request|multiline|memo|textarea)\b/.test(value)) return 'paragraph';
  if (/\b(required\??|requested\??|yes.?no|boolean|checkbox)\b/.test(value)) return 'checkbox';
  if (/\b(department|location|type|monitor|phone|employment|dropdown|select|combo|choice|picklist|radio)\b/.test(value)) return 'select';
  return 'text';
}

function looksLikeField(node: Element): boolean {
  const tag = node.tagName.toLowerCase();
  if (/parameter|field|question|control|prompt/.test(tag)) return true;
  const attrs = [...node.attributes].map((a) => `${a.name}=${a.value}`).join(' ').toLowerCase();
  return /field|parameter|question|control/.test(attrs);
}

function fieldName(node: Element): string {
  return cleanText(
    attributeOf(node, ['displayName', 'DisplayName', 'label', 'Label', 'prompt', 'Prompt', 'name', 'Name']) ||
    textOf(node, [
      ':scope > DisplayName', ':scope > displayName', ':scope > Label', ':scope > label',
      ':scope > Prompt', ':scope > prompt', ':scope > Name', ':scope > name'
    ])
  );
}

function rawType(node: Element): string {
  return (
    attributeOf(node, ['type', 'Type', 'dataType', 'DataType', 'controlType', 'ControlType']) ||
    textOf(node, [
      ':scope > Type', ':scope > type', ':scope > DataType',
      ':scope > dataType', ':scope > ControlType', ':scope > controlType'
    ])
  ).trim();
}

function required(node: Element): boolean {
  const value =
    attributeOf(node, ['required', 'Required', 'mandatory', 'Mandatory', 'isRequired']) ||
    textOf(node, [
      ':scope > Required', ':scope > required', ':scope > Mandatory',
      ':scope > mandatory', ':scope > IsRequired', ':scope > isRequired'
    ]);
  return /^(true|1|yes|required|mandatory)$/i.test(value.trim());
}

function description(node: Element): string {
  return cleanText(textOf(node, [
    ':scope > Description', ':scope > description',
    ':scope > HelpText', ':scope > helpText',
    ':scope > Hint', ':scope > hint'
  ]));
}

function englishOptions(node: Element, jiraType: JiraFieldType): string[] {
  if (jiraType === 'checkbox') return ['Yes', 'No'];
  if (jiraType !== 'select') return [];

  const nodes = [...node.querySelectorAll(
    ':scope Option, :scope option, :scope ListItem, :scope listItem, :scope Choice, :scope choice'
  )];

  return unique(nodes.map((item) => {
    const locale = attributeOf(item, ['locale', 'language', 'lang', 'culture']).toLowerCase();
    if (locale && !/^(en|en-gb|en-us|english)$/.test(locale)) return '';
    return cleanText(
      attributeOf(item, ['displayName', 'name', 'label', 'value']) ||
      item.textContent?.trim() || ''
    );
  })).filter((value) => value.length <= 100).slice(0, 100);
}

function workflowLabel(node: Element): string {
  return cleanText(
    attributeOf(node, [
      'displayName', 'DisplayName', 'name', 'Name', 'label', 'Label',
      'title', 'Title', 'taskName', 'activityName'
    ]) ||
    textOf(node, [
      ':scope > DisplayName', ':scope > displayName',
      ':scope > Name', ':scope > name',
      ':scope > Label', ':scope > label',
      ':scope > Title', ':scope > title',
      ':scope > TaskName', ':scope > ActivityName'
    ])
  );
}

function classifyWorkflow(node: Element, label: string): WorkflowCategory {
  const value = `${node.tagName} ${attributeOf(node, ['type', 'Type', 'class', 'Class'])} ${label}`.toLowerCase();
  if (/approval|approve|authoris/.test(value)) return 'approval';
  if (/condition|decision|branch|if |switch|expression/.test(value)) return 'condition';
  if (/notification|notify|email|message/.test(value)) return 'notification';
  if (/transition|route|connector|link/.test(value)) return 'transition';
  if (/task|workorder|fulfil|fulfill|provision|create .*account|setup|configure|prepare/.test(value)) return 'task';
  return 'activity';
}

function workflowAssignment(node: Element): string {
  return cleanText(
    attributeOf(node, ['team', 'Team', 'group', 'Group', 'assignmentGroup', 'ownerTeam', 'assignee']) ||
    textOf(node, [
      ':scope > Team', ':scope > Group', ':scope > AssignmentGroup',
      ':scope > OwnerTeam', ':scope > Assignee'
    ])
  );
}

function workflowCondition(node: Element): string {
  return cleanText(
    attributeOf(node, ['condition', 'Condition', 'expression', 'Expression', 'rule', 'Rule']) ||
    textOf(node, [
      ':scope > Condition', ':scope > condition',
      ':scope > Expression', ':scope > expression',
      ':scope > Rule', ':scope > rule'
    ])
  );
}

function extractWorkflow(document: XMLDocument, serviceName: string): WorkflowItem[] {
  const candidates = [...document.querySelectorAll('*')].filter((node) => {
    const tag = node.tagName.toLowerCase();
    const attrs = [...node.attributes].map((a) => `${a.name}=${a.value}`).join(' ').toLowerCase();
    return /workflow|task|activity|approval|transition|block|decision|condition|notification|workorder/.test(`${tag} ${attrs}`);
  });

  const seen = new Set<string>();
  const items: WorkflowItem[] = [];

  for (const node of candidates) {
    const label = workflowLabel(node);
    if (!label || label.length < 3 || label.length > 180) continue;
    if (label.toLowerCase() === serviceName.toLowerCase()) continue;

    const category = classifyWorkflow(node, label);
    const assignment = workflowAssignment(node);
    const condition = workflowCondition(node);
    const signature = `${category}|${label.toLowerCase()}|${assignment.toLowerCase()}|${condition.toLowerCase()}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    items.push({
      id: `workflow-${items.length + 1}`,
      label,
      category,
      sourceTag: node.tagName,
      assignment: assignment || undefined,
      condition: condition || undefined,
      sequence: items.length + 1
    });
  }

  return items.slice(0, 250);
}


function workflowNodeKey(node: Element): string {
  return cleanText(
    attributeOf(node, [
      'id', 'Id', 'ID', 'guid', 'Guid', 'GUID', 'key', 'Key',
      'uid', 'Uid', 'objectId', 'ObjectId', 'activityId', 'statusId'
    ]) ||
    textOf(node, [
      ':scope > Id', ':scope > ID', ':scope > id',
      ':scope > Guid', ':scope > GUID', ':scope > guid',
      ':scope > Key', ':scope > key'
    ])
  );
}

function workflowReference(node: Element, direction: 'from' | 'to'): string {
  const names = direction === 'from'
    ? ['from', 'From', 'source', 'Source', 'sourceId', 'SourceId', 'fromId', 'FromId', 'fromStatus', 'FromStatus', 'sourceStatus']
    : ['to', 'To', 'target', 'Target', 'targetId', 'TargetId', 'toId', 'ToId', 'toStatus', 'ToStatus', 'targetStatus', 'next', 'Next'];
  const selectors = direction === 'from'
    ? [':scope > From', ':scope > from', ':scope > Source', ':scope > source', ':scope > FromStatus', ':scope > fromStatus']
    : [':scope > To', ':scope > to', ':scope > Target', ':scope > target', ':scope > ToStatus', ':scope > toStatus', ':scope > Next', ':scope > next'];

  return cleanText(attributeOf(node, names) || textOf(node, selectors));
}

function workflowStatusCategory(name: string): 'TODO' | 'IN_PROGRESS' | 'DONE' {
  const value = name.toLowerCase();
  if (/\b(done|complete|completed|closed|cancelled|canceled|rejected|resolved|fulfilled)\b/.test(value)) return 'DONE';
  if (/\b(new|open|submitted|requested|created|draft|pending)\b/.test(value)) return 'TODO';
  return 'IN_PROGRESS';
}

function statusLikeNode(node: Element): boolean {
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attributes].map((a) => `${a.name}=${a.value}`).join(' ').toLowerCase();
  return /(^|[-_:])(status|state|stage)([-_:]|$)/.test(tag) ||
    /\b(type|class|kind)=(["']?)(status|state|stage)\b/.test(attrs) ||
    /\b(statusname|statename|stagename)=/.test(attrs);
}

function transitionLikeNode(node: Element): boolean {
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attributes].map((a) => `${a.name}=${a.value}`).join(' ').toLowerCase();
  return /transition|connector|route|workflowlink|activitylink/.test(tag) ||
    /\b(type|class|kind)=(["']?)(transition|connector|route|link)\b/.test(attrs) ||
    /\b(fromstatus|tostatus|sourceid|targetid|fromid|toid)=/.test(attrs);
}

function extractWorkflowMigrationModel(
  document: XMLDocument,
  serviceName: string,
  items: WorkflowItem[]
): WorkflowMigrationModel {
  const statuses: WorkflowStatusCandidate[] = [];
  const statusSeen = new Set<string>();
  const statusByKey = new Map<string, string>();

  for (const node of [...document.querySelectorAll('*')].filter(statusLikeNode)) {
    const name = workflowLabel(node);
    if (!name || name.length < 2 || name.length > 140 || name.toLowerCase() === serviceName.toLowerCase()) continue;
    const normalised = name.toLowerCase();
    if (statusSeen.has(normalised)) continue;

    const sourceKey = workflowNodeKey(node);
    const status: WorkflowStatusCandidate = {
      id: `status-${statuses.length + 1}`,
      name,
      sourceTag: node.tagName,
      sourceKey: sourceKey || undefined,
      statusCategory: workflowStatusCategory(name),
      confidence: sourceKey ? 95 : 80
    };
    statuses.push(status);
    statusSeen.add(normalised);
    if (sourceKey) statusByKey.set(sourceKey.toLowerCase(), name);
    statusByKey.set(normalised, name);
  }

  const transitions: WorkflowTransitionCandidate[] = [];
  const transitionSeen = new Set<string>();

  const resolveReference = (value: string): string | undefined => {
    const cleaned = cleanText(value);
    if (!cleaned) return undefined;
    return statusByKey.get(cleaned.toLowerCase()) ||
      statuses.find((status) => status.name.toLowerCase() === cleaned.toLowerCase())?.name ||
      (!/^[{(]?[0-9a-f-]{8,}[)}]?$/i.test(cleaned) && cleaned.length <= 140 ? cleaned : undefined);
  };

  for (const node of [...document.querySelectorAll('*')].filter(transitionLikeNode)) {
    const rawFrom = workflowReference(node, 'from');
    const rawTo = workflowReference(node, 'to');
    const fromStatus = resolveReference(rawFrom);
    const toStatus = resolveReference(rawTo);
    const label = workflowLabel(node) || [fromStatus, toStatus].filter(Boolean).join(' → ') || `Transition ${transitions.length + 1}`;
    const condition = workflowCondition(node);
    const assignment = workflowAssignment(node);

    if (fromStatus && !statusSeen.has(fromStatus.toLowerCase())) {
      statuses.push({
        id: `status-${statuses.length + 1}`,
        name: fromStatus,
        sourceTag: node.tagName,
        statusCategory: workflowStatusCategory(fromStatus),
        confidence: 65
      });
      statusSeen.add(fromStatus.toLowerCase());
      statusByKey.set(fromStatus.toLowerCase(), fromStatus);
    }
    if (toStatus && !statusSeen.has(toStatus.toLowerCase())) {
      statuses.push({
        id: `status-${statuses.length + 1}`,
        name: toStatus,
        sourceTag: node.tagName,
        statusCategory: workflowStatusCategory(toStatus),
        confidence: 65
      });
      statusSeen.add(toStatus.toLowerCase());
      statusByKey.set(toStatus.toLowerCase(), toStatus);
    }

    const signature = `${label.toLowerCase()}|${fromStatus ?? ''}|${toStatus ?? ''}`;
    if (transitionSeen.has(signature)) continue;
    transitionSeen.add(signature);

    let confidence = 35;
    let reviewReason: string | undefined;
    if (fromStatus && toStatus) confidence = 95;
    else if (toStatus) {
      confidence = 65;
      reviewReason = 'A target status was detected but the source status was not explicit.';
    } else {
      reviewReason = 'The transition source/target statuses could not be resolved from the XML.';
    }

    transitions.push({
      id: `transition-${transitions.length + 1}`,
      name: label,
      sourceTag: node.tagName,
      fromStatus,
      toStatus,
      condition: condition || undefined,
      assignment: assignment || undefined,
      confidence,
      reviewReason
    });
  }

  const approvals = items.filter((item) => item.category === 'approval');
  const notifications = items.filter((item) => item.category === 'notification');
  const buildableTransitions = transitions.filter((transition) => transition.fromStatus && transition.toStatus);
  const reviewItems: string[] = [];

  transitions.filter((transition) => transition.reviewReason).forEach((transition) => {
    reviewItems.push(`${transition.name}: ${transition.reviewReason}`);
  });
  if (approvals.length) {
    reviewItems.push(`${approvals.length} approval activity/activities detected. Approval semantics require Jira/JSM approval review and are not silently converted into simple transitions.`);
  }
  if (notifications.length) {
    reviewItems.push(`${notifications.length} notification activity/activities detected. These belong in the automation migration phase rather than the native workflow definition.`);
  }
  items.filter((item) => item.category === 'condition').forEach((item) => {
    reviewItems.push(`Condition "${item.label}" requires review before being implemented as a Jira transition rule or automation condition.`);
  });

  const canBuild = statuses.length >= 2 && buildableTransitions.length >= 1;
  const evidenceCount = statuses.length + transitions.length;
  const averageConfidence = evidenceCount
    ? Math.round(
        (
          statuses.reduce((sum, status) => sum + status.confidence, 0) +
          transitions.reduce((sum, transition) => sum + transition.confidence, 0)
        ) / evidenceCount
      )
    : 0;

  if (!statuses.length) reviewItems.push('No explicit Ivanti status/state/stage elements were detected.');
  if (statuses.length && !buildableTransitions.length) reviewItems.push('Statuses were detected, but no transition with both a source and target status could be resolved.');

  return {
    statuses,
    transitions,
    approvals,
    notifications,
    reviewItems,
    confidence: averageConfidence,
    canBuild
  };
}

function suggestJiraWorkflow(items: WorkflowItem[]): SuggestedWorkflow {
  const tasks = unique(items.filter((item) => item.category === 'task').map((item) => item.label));
  const hasApproval = items.some((item) => item.category === 'approval');
  const hasConditions = items.some((item) => item.category === 'condition');

  const statuses = ['Submitted'];
  if (hasApproval) statuses.push('Awaiting Approval');
  if (tasks.length) statuses.push('Provisioning');
  statuses.push('Completed', 'Cancelled');

  const notes = [
    'Keep fulfilment activities as child tasks rather than creating one parent status per task.',
    'Review the detected sequence because Ivanti XML structures vary between exports.'
  ];
  if (hasConditions) notes.push('Detected branches should be implemented with Jira Automation conditions or Forge logic.');
  if (!tasks.length) notes.push('No reliable fulfilment tasks were detected; inspect the raw workflow labels before creating a Jira workflow.');

  return { statuses, taskNames: tasks, notes };
}

export function parseIvantiXml(xmlText: string, fileName = ''): Analysis {
  const parser = new DOMParser();
  const document = parser.parseFromString(xmlText, 'application/xml');
  if (document.querySelector('parsererror')) {
    throw new Error('The file is not valid XML. ROX files work only when they contain XML.');
  }

  const fromFile = fileName.replace(/\.(xml|rox|txt)$/i, '').trim();
  const explicitName = textOf(document, [
    'ServiceReqTemplateName', 'ServiceRequestName', 'OfferingName',
    'ServiceOfferingName', 'RequestOfferingName'
  ]);
  const serviceName = cleanText(explicitName) || fromFile || 'Unnamed Ivanti service';

  const serviceDescription = cleanText(textOf(document, [
    'ServiceReqTemplateDescription', 'OfferingDescription',
    'ServiceOfferingDescription', 'RequestOfferingDescription', 'Description'
  ]));

  const seen = new Set<string>();
  const fields: ParsedField[] = [];

  for (const node of [...document.querySelectorAll('*')].filter(looksLikeField)) {
    const name = fieldName(node);
    if (!name || name.length > 160) continue;

    const lower = name.toLowerCase();
    if (seen.has(lower) || ['name', 'value', 'field', 'parameter', 'description', serviceName.toLowerCase()].includes(lower)) continue;

    const sourceType = rawType(node);
    const jiraType = inferType(sourceType, name);

    seen.add(lower);
    fields.push({
      id: `${fields.length + 1}-${lower.replace(/[^a-z0-9]+/g, '-')}`,
      ivantiName: name,
      name,
      description: description(node),
      rawType: sourceType || `Inferred as ${jiraType}`,
      jiraType,
      required: required(node),
      options: englishOptions(node, jiraType),
      selected: false
    });
  }

  const workflowItems = extractWorkflow(document, serviceName);
  const workflowLabels = unique(workflowItems.map((item) => item.label));
  const suggestedWorkflow = suggestJiraWorkflow(workflowItems);
  const workflowMigration = extractWorkflowMigrationModel(document, serviceName, workflowItems);

  return {
    serviceName,
    description: serviceDescription,
    fields,
    workflowLabels,
    workflowItems,
    suggestedWorkflow,
    workflowMigration,
    stats: {
      fields: fields.length,
      workflowItems: workflowItems.length,
      tasks: workflowItems.filter((item) => item.category === 'task').length,
      approvals: workflowItems.filter((item) => item.category === 'approval').length,
      conditions: workflowItems.filter((item) => item.category === 'condition').length,
      notifications: workflowItems.filter((item) => item.category === 'notification').length,
      xmlElements: document.querySelectorAll('*').length
    }
  };
}
