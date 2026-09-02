// Orchestration-aware workflow analysis for Ivanti GetInstance imports.
// Captures the raw workflow graph before the compatibility layer rewrites the
// file input, then replaces the legacy status-centric workflow panel with a
// fulfilment-orchestration view that matches how Ivanti service workflows work.

const RawDOMParser = window.DOMParser;

type Edge = { sourceId: string; sourceTitle: string; exit: string; targetId: string; targetTitle: string };
type Task = { id: string; title: string; team?: string; summary?: string; details?: string; due?: string };
type Branch = { id: string; title: string; condition?: string };
type Action = { id: string; title: string; type: string; quickActionId?: string; invokedWorkflowId?: string };
type Model = {
  name: string;
  version?: string;
  context?: string;
  status?: string;
  exception?: string;
  blocks: number;
  tasks: Task[];
  joins: string[];
  branches: Branch[];
  actions: Action[];
  starts: number;
  stops: number;
  edges: Edge[];
  reachable: number;
  defects: string[];
};

let currentModel: Model | null = null;

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function childText(parent: Element, selectors: string[]): string {
  for (const selector of selectors) {
    const value = clean(parent.querySelector(selector)?.textContent || '');
    if (value) return value;
  }
  return '';
}

function paramValue(block: Element, names: string[]): string {
  const wanted = names.map((name) => name.toLowerCase());
  for (const param of Array.from(block.querySelectorAll('param'))) {
    const name = childText(param, [':scope > name', ':scope > Name']).toLowerCase();
    if (wanted.includes(name)) return childText(param, [':scope > value', ':scope > Value']);
  }
  return '';
}

function blockId(block: Element): string {
  return childText(block, [':scope > id', ':scope > Id', ':scope > ID']);
}

function blockType(block: Element): string {
  return childText(block, [':scope > type', ':scope > Type']).toLowerCase();
}

function blockTitle(block: Element): string {
  return childText(block, [':scope > title', ':scope > Title']);
}

function exitTitle(exit: Element): string {
  return childText(exit, [':scope > title', ':scope > Title', ':scope > name', ':scope > Name']);
}

function destination(link: Element): string {
  return childText(link, [':scope > blockId', ':scope > BlockId', ':scope > destinationBlockId', ':scope > targetBlockId', ':scope > target', ':scope > Target']);
}

function deriveCondition(block: Element): string {
  const field = paramValue(block, ['field', 'fieldname']);
  const operator = paramValue(block, ['operator']);
  const value = paramValue(block, ['value']);
  return [field, operator, value].filter(Boolean).join(' ');
}

function parseModel(text: string): Model | null {
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as { d?: Record<string, unknown> };
    payload = parsed.d;
  } catch {
    return null;
  }

  const details = typeof payload?.Details === 'string' ? payload.Details : '';
  if (!details || !/<(scenario|workflow)\b/i.test(details)) return null;

  const doc = new RawDOMParser().parseFromString(details, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  const blocks = Array.from(doc.querySelectorAll('blocks > block'));
  if (!blocks.length) return null;

  const byId = new Map<string, Element>();
  for (const block of blocks) {
    const id = blockId(block);
    if (id) byId.set(id, block);
  }

  const tasks: Task[] = [];
  const joins: string[] = [];
  const branches: Branch[] = [];
  const actions: Action[] = [];
  const edges: Edge[] = [];
  const adjacency = new Map<string, string[]>();
  let starts = 0;
  let stops = 0;

  for (const block of blocks) {
    const id = blockId(block);
    const type = blockType(block);
    const title = blockTitle(block) || `${type || 'block'} [${id.slice(0, 8)}]`;

    if (type === 'start') starts += 1;
    if (type === 'stop') stops += 1;
    if (type === 'task') {
      tasks.push({
        id,
        title,
        team: paramValue(block, ['team', 'assignment team', 'owner team']) || undefined,
        summary: paramValue(block, ['summary', 'subject']) || undefined,
        details: paramValue(block, ['details', 'detail', 'description']) || undefined,
        due: paramValue(block, ['duedate', 'due date', 'duration', 'duedateduration']) || undefined
      });
    }
    if (type === 'join') joins.push(title);
    if (['if', 'switch', 'decision'].includes(type)) branches.push({ id, title, condition: deriveCondition(block) || undefined });
    if (['quickaction', 'update', 'invokeworkflow', 'approval'].includes(type)) {
      actions.push({
        id,
        title,
        type,
        quickActionId: paramValue(block, ['qaid', 'quickactionid', 'quick action id']) || undefined,
        invokedWorkflowId: paramValue(block, ['workflowid', 'workflow id']) || undefined
      });
    }

    const next: string[] = [];
    for (const exit of Array.from(block.querySelectorAll(':scope > exits > exit'))) {
      const exitName = exitTitle(exit) || 'exit';
      for (const link of Array.from(exit.querySelectorAll(':scope > links > link, :scope > link'))) {
        const targetId = destination(link);
        if (!targetId) continue;
        next.push(targetId);
        const target = byId.get(targetId);
        edges.push({
          sourceId: id,
          sourceTitle: title,
          exit: exitName,
          targetId,
          targetTitle: target ? (blockTitle(target) || `${blockType(target)} [${targetId.slice(0, 8)}]`) : `block ${targetId.slice(0, 8)}`
        });
      }
    }
    adjacency.set(id, next);
  }

  const startIds = blocks.filter((block) => blockType(block) === 'start').map(blockId).filter(Boolean);
  const reachable = new Set<string>();
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adjacency.get(id) || []) if (!reachable.has(next)) queue.push(next);
  }

  const defects: string[] = [];
  const exception = clean(payload?.Exception);
  if (exception) defects.push(`Ivanti instance status is ${clean(payload?.Status) || 'failed'}: ${exception}`);

  for (const block of blocks) {
    const id = blockId(block);
    const type = blockType(block);
    if (!id || !reachable.has(id) || !['quickaction', 'update'].includes(type)) continue;
    const title = blockTitle(block) || `Unnamed ${type === 'quickaction' ? 'Quick Action' : 'Update'} [${id.slice(0, 8)}]`;
    for (const exit of Array.from(block.querySelectorAll(':scope > exits > exit'))) {
      const name = exitTitle(exit).toLowerCase();
      const links = exit.querySelectorAll(':scope > links > link, :scope > link');
      if (['ok', 'success', 'completed'].includes(name) && links.length === 0) {
        defects.push(`${title} has a reachable unconnected ${exitTitle(exit) || 'success'} exit.`);
      }
    }
  }

  return {
    name: clean(payload?.Name) || 'Ivanti workflow',
    version: clean(payload?.Version) || undefined,
    context: clean(payload?.ContextBO) || undefined,
    status: clean(payload?.Status) || undefined,
    exception: exception || undefined,
    blocks: blocks.length,
    tasks,
    joins,
    branches,
    actions,
    starts,
    stops,
    edges,
    reachable: reachable.size,
    defects: [...new Set(defects)]
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function card(title: string, value: string | number, note: string): string {
  return `<div style="background:#f1f2f4;border-radius:8px;padding:16px"><strong style="display:block;font-size:28px">${escapeHtml(value)}</strong><span style="color:#5e6c84">${escapeHtml(title)}</span><div style="font-size:12px;color:#6b778c;margin-top:5px">${escapeHtml(note)}</div></div>`;
}

function item(title: string, meta: string, tone = '#0c66e4'): string {
  return `<div style="border:1px solid #dcdfe4;border-left:5px solid ${tone};border-radius:7px;padding:12px;margin-top:9px"><strong>${escapeHtml(title)}</strong>${meta ? `<div style="color:#5e6c84;margin-top:5px">${escapeHtml(meta)}</div>` : ''}</div>`;
}

function renderSemanticPanel(model: Model): string {
  const coverage = model.blocks ? Math.round((model.reachable / model.blocks) * 100) : 0;
  const unresolvedActions = model.actions.filter((action) => (action.type === 'quickaction' || action.type === 'update') && !action.quickActionId).length;
  const gate = model.defects.length ? 'Review source defects before Jira build' : 'Ready for migration design review';

  const taskHtml = model.tasks.map((task) => item(task.title, [task.team && `Team: ${task.team}`, task.summary, task.due && `Due: ${task.due}`].filter(Boolean).join(' • '))).join('');
  const branchHtml = model.branches.map((branch) => item(branch.title, branch.condition || 'Decision/branch logic detected', '#9f8fef')).join('');
  const joinHtml = model.joins.map((join) => item(join, 'Join/gate: wait for upstream fulfilment before continuing', '#e56910')).join('');
  const actionHtml = model.actions.map((action) => item(action.title, [action.type, action.quickActionId && `Quick Action ${action.quickActionId}`, action.invokedWorkflowId && `Invokes workflow ${action.invokedWorkflowId}`].filter(Boolean).join(' • '), '#22a06b')).join('');
  const defectHtml = model.defects.length
    ? model.defects.map((defect) => item('Source workflow defect', defect, '#c9372c')).join('')
    : item('No blocking source defects detected', 'All reachable non-waiting success paths are connected.', '#22a06b');
  const routeHtml = model.edges.slice(0, 30).map((edge) => item(`${edge.sourceTitle} — ${edge.exit} → ${edge.targetTitle}`, 'Ivanti fulfilment route', '#6b778c')).join('');

  return `
    <div class="orchestrationSemanticPanel" style="background:white;border:1px solid #dcdfe4;border-radius:10px;padding:21px;box-shadow:0 1px 2px rgba(9,30,66,.06)">
      <div style="display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <h2 style="margin:0 0 6px">Ivanti Workflow Orchestration Analysis</h2>
          <p style="margin:0;color:#5e6c84">${escapeHtml(model.name)}${model.version ? ` • Version ${escapeHtml(model.version)}` : ''}${model.context ? ` • ${escapeHtml(model.context)}` : ''}. Tasks, joins and branches are translated as fulfilment orchestration, not parent Jira statuses.</p>
        </div>
        <span style="padding:7px 11px;border-radius:999px;font-weight:700;background:${model.defects.length ? '#ffebe6' : '#dcfff1'};color:${model.defects.length ? '#ae2a19' : '#164b35'}">${escapeHtml(gate)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:18px 0">
        ${card('Fulfilment tasks', model.tasks.length, 'Child work items')}
        ${card('Joins / gates', model.joins.length, 'Parallel-stage control')}
        ${card('Branches', model.branches.length, 'Conditional routing')}
        ${card('Actions', model.actions.length, 'Quick actions / invokes')}
        ${card('Graph coverage', `${coverage}%`, `${model.reachable}/${model.blocks} reachable blocks`)}
        ${card('Source defects', model.defects.length, unresolvedActions ? `${unresolvedActions} action(s) unresolved` : 'Reachability checked')}
      </div>
      <div style="padding:14px;border-left:4px solid #0c66e4;background:#e9f2ff;border-radius:5px;margin-bottom:18px"><strong>Recommended Jira semantic model</strong><div style="margin-top:6px;color:#44546f">Keep the parent request lifecycle compact (Submitted → Fulfilment → Completed/Cancelled). Create the Ivanti task blocks as child fulfilment work, implement joins as automation gates, branches as conditions, and notifications/actions as automation candidates.</div></div>
      <h3>Fulfilment tasks (${model.tasks.length})</h3>${taskHtml || '<p style="color:#5e6c84">No task blocks detected.</p>'}
      <h3 style="margin-top:22px">Parallel joins / gates (${model.joins.length})</h3>${joinHtml || '<p style="color:#5e6c84">No join blocks detected.</p>'}
      <h3 style="margin-top:22px">Branches (${model.branches.length})</h3>${branchHtml || '<p style="color:#5e6c84">No conditional branch blocks detected.</p>'}
      <h3 style="margin-top:22px">Actions and invoked workflows (${model.actions.length})</h3>${actionHtml || '<p style="color:#5e6c84">No action blocks detected.</p>'}
      <h3 style="margin-top:22px">Source validation</h3>${defectHtml}
      <details style="margin-top:22px"><summary style="cursor:pointer;font-weight:700">Show ${model.edges.length} source routes</summary><div style="margin-top:10px">${routeHtml}${model.edges.length > 30 ? `<p style="color:#5e6c84">Showing first 30 of ${model.edges.length} routes.</p>` : ''}</div></details>
    </div>`;
}

function applyOverlay(): void {
  if (!currentModel) return;
  const headings = Array.from(document.querySelectorAll('h2'));
  const oldHeading = headings.find((heading) => clean(heading.textContent) === 'Workflow Migration Engine');
  if (!oldHeading) return;
  const oldPanel = oldHeading.closest('section.panel');
  if (!oldPanel || !oldPanel.parentElement) return;

  const existing = oldPanel.parentElement.querySelector(':scope > .orchestrationSemanticPanel') as HTMLElement | null;
  if (existing) {
    oldPanel.setAttribute('style', 'display:none !important');
    return;
  }

  const holder = document.createElement('div');
  holder.innerHTML = renderSemanticPanel(currentModel);
  const semantic = holder.firstElementChild as HTMLElement | null;
  if (!semantic) return;
  oldPanel.parentElement.insertBefore(semantic, oldPanel);
  oldPanel.setAttribute('style', 'display:none !important');
}

// Capture the real GetInstance JSON before workflowInstanceCompat replaces the
// selected files with its merged synthetic XML file.
document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement | null;
  if (!input || input.type !== 'file' || !input.files?.length) return;
  const json = Array.from(input.files).find((file) => /\.json$/i.test(file.name));
  if (!json) return;
  void json.text().then((text) => {
    const model = parseModel(text);
    if (model) {
      currentModel = model;
      window.setTimeout(applyOverlay, 100);
    }
  }).catch(() => undefined);
}, true);

const observer = new MutationObserver(() => applyOverlay());
observer.observe(document.documentElement, { subtree: true, childList: true });
