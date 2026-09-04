import type { ParsedWorkflow } from './WorkflowXmlImportMount';

export type OrchestrationNodeKind =
  | 'start' | 'stop' | 'task' | 'gate' | 'decision' | 'action' | 'wait' | 'approval' | 'unsupported';

export type OrchestrationTransition = {
  sourceId: string;
  sourceTitle: string;
  outcome: string;
  condition?: string;
  targetId: string;
  targetTitle: string;
};

export type OrchestrationNode = {
  id: string;
  sourceType: string;
  kind: OrchestrationNodeKind;
  title: string;
  summary?: string;
  details?: string;
  team?: string;
  dueDays?: number;
  quickActionId?: string;
  actionKind?: string;
  condition?: string;
  outcomes: string[];
};

export type CompiledOrchestrationGraph = {
  version: 2;
  workflowName: string;
  workflowVersion: string;
  objectType: string;
  entryNodeIds: string[];
  nodes: OrchestrationNode[];
  transitions: OrchestrationTransition[];
  unsupportedNodeIds: string[];
  defects: string[];
  compiledAt: string;
};

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

function param(block: ParsedWorkflow['workflow']['blocks'][number], ...names: string[]): string {
  const wanted = names.map((name) => name.toLowerCase());
  return clean(block.params.find((item) => wanted.includes(clean(item.name).toLowerCase()))?.value);
}

function kindFor(type: string): OrchestrationNodeKind {
  const value = clean(type).toLowerCase();
  if (value === 'start') return 'start';
  if (value === 'stop') return 'stop';
  if (value === 'task' || value === 'create') return 'task';
  if (value === 'join') return 'gate';
  if (['if', 'switch', 'decision'].includes(value)) return 'decision';
  if (['quickaction', 'update', 'invokeworkflow'].includes(value)) return 'action';
  if (['wait', 'waitfor', 'waitstatus', 'waitforstatus', 'waitforchild'].includes(value)) return 'wait';
  if (value === 'approval') return 'approval';
  return 'unsupported';
}

function actionKind(workflow: ParsedWorkflow, block: ParsedWorkflow['workflow']['blocks'][number]): string | undefined {
  const qaId = param(block, 'qaid', 'quickactionid', 'quick action id');
  if (!qaId) return block.type === 'update' ? 'update' : block.type === 'invokeworkflow' ? 'invoke-workflow' : undefined;
  const action = workflow.workflow.quickActions.find((item) => clean(item.id).toLowerCase() === qaId.toLowerCase());
  return action?.semantic?.kind || action?.actionType || 'quick-action';
}

function conditionFor(block: ParsedWorkflow['workflow']['blocks'][number]): string | undefined {
  const field = param(block, 'field', 'fieldname', 'field name');
  const operator = param(block, 'operator');
  const value = param(block, 'value');
  const result = [field, operator, value].filter(Boolean).join(' ');
  return result || undefined;
}

export function compileIvantiGraph(workflow: ParsedWorkflow): CompiledOrchestrationGraph {
  const nodes: OrchestrationNode[] = workflow.workflow.blocks.map((block) => {
    const dueRaw = param(block, 'duedatedays', 'timeoutdays', 'due days', 'timeout days');
    const due = Number(dueRaw);
    const quickActionId = param(block, 'qaid', 'quickactionid', 'quick action id') || undefined;
    return {
      id: String(block.id),
      sourceType: block.type,
      kind: kindFor(block.type),
      title: clean(block.title) || `${block.type} ${String(block.id).slice(0, 8)}`,
      summary: param(block, 'summary', 'subject') || undefined,
      details: param(block, 'details', 'detail', 'description') || undefined,
      team: param(block, 'team', 'assignment team', 'owner team') || undefined,
      dueDays: Number.isFinite(due) && due > 0 ? due : undefined,
      quickActionId,
      actionKind: actionKind(workflow, block),
      condition: conditionFor(block),
      outcomes: block.exits.map((exit) => clean(exit.title).toLowerCase()).filter(Boolean)
    };
  });

  const blockById = new Map(workflow.workflow.blocks.map((block) => [String(block.id), block]));
  const transitions: OrchestrationTransition[] = [];
  for (const block of workflow.workflow.blocks) {
    for (const exit of block.exits) {
      for (const targetId of exit.links) {
        transitions.push({
          sourceId: String(block.id),
          sourceTitle: block.title,
          outcome: clean(exit.title).toLowerCase() || 'ok',
          condition: clean(exit.condition) || undefined,
          targetId: String(targetId),
          targetTitle: blockById.get(String(targetId))?.title || `block ${String(targetId).slice(0, 8)}`
        });
      }
    }
  }

  const starts = nodes.filter((node) => node.kind === 'start').map((node) => node.id);
  const entryNodeIds = [...new Set(transitions.filter((edge) => starts.includes(edge.sourceId)).map((edge) => edge.targetId))];
  const unsupportedNodeIds = nodes.filter((node) => node.kind === 'unsupported').map((node) => node.id);
  const defects = [...workflow.workflow.derived.defects];
  for (const node of nodes) {
    if (node.kind === 'unsupported') defects.push(`Unsupported Ivanti block type '${node.sourceType}' at ${node.title}.`);
    if (node.kind !== 'stop' && !transitions.some((edge) => edge.sourceId === node.id) && node.outcomes.length) {
      defects.push(`${node.title} has outcomes but no connected outgoing route.`);
    }
  }

  return {
    version: 2,
    workflowName: workflow.workflow.name,
    workflowVersion: workflow.workflow.version,
    objectType: workflow.workflow.objectType,
    entryNodeIds,
    nodes,
    transitions,
    unsupportedNodeIds,
    defects: [...new Set(defects)],
    compiledAt: new Date().toISOString()
  };
}
