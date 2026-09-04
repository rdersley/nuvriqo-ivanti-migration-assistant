import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

type Param = { name: string; value: string };
type WorkflowEdge = { sourceId: string; sourceTitle: string; exit: string; targetId: string; targetTitle: string };
type TriggerCondition = { field: string; operator: string; value: string };
type QuickAction = {
  id: string;
  objectId: string;
  name: string;
  actionType: string;
  groupName: string;
  definition: unknown;
  rawDefinition: string;
};
type WorkflowBlock = {
  id: string;
  type: string;
  title: string;
  params: Param[];
  exits: Array<{ title: string; links: string[]; condition: string }>;
};
type ParsedWorkflow = {
  source: 'ivanti-workflow-export' | 'ivanti-getinstance';
  sourceFile: string;
  capturedAt: string;
  workflow: {
    name: string;
    displayName: string;
    description: string;
    objectType: string;
    version: string;
    status: string;
    exception: string;
    blocks: WorkflowBlock[];
    edges: WorkflowEdge[];
    trigger: {
      events: { created: boolean; updated: boolean; deleted: boolean };
      logical: string;
      conditions: TriggerCondition[];
    };
    quickActions: QuickAction[];
    derived: {
      starts: number;
      stops: number;
      tasks: string[];
      joins: string[];
      branches: string[];
      actions: string[];
      waits: string[];
      approvals: string[];
      reachable: number;
      defects: string[];
    };
  };
};

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

function directChildText(parent: Element, tag: string): string {
  const child = Array.from(parent.children).find((item) => item.localName.toLowerCase() === tag.toLowerCase());
  return clean(child?.textContent || '');
}

function paramsFor(block: Element): Param[] {
  return Array.from(block.querySelectorAll('param')).map((param) => ({
    name: directChildText(param, 'name'),
    value: directChildText(param, 'value')
  })).filter((param) => param.name || param.value);
}

function safeQuickActionDefinition(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  const normalized = text
    .replace(/new\s+Date\s*\(\s*(\d+)\s*\)/g, '"$1"')
    .replace(/\bundefined\b/g, 'null');
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function parseTrigger(xmlText: string) {
  const result = {
    events: { created: false, updated: false, deleted: false },
    logical: '',
    conditions: [] as TriggerCondition[]
  };
  if (!xmlText.trim()) return result;
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return result;

  for (const property of Array.from(doc.querySelectorAll('property'))) {
    const name = directChildText(property, 'name').toLowerCase();
    const groups = Array.from(property.querySelectorAll(':scope > groups > group'));
    if (name === 'contextblock') {
      for (const param of groups.flatMap((group) => Array.from(group.querySelectorAll(':scope > param')))) {
        const key = directChildText(param, 'name').toLowerCase();
        const value = directChildText(param, 'value').toLowerCase();
        if (key === 'created') result.events.created = value === 'yes' || value === 'true';
        if (key === 'updated') result.events.updated = value === 'yes' || value === 'true';
        if (key === 'deleted') result.events.deleted = value === 'yes' || value === 'true';
      }
    }
    if (name === 'logical') {
      for (const group of groups) {
        for (const param of Array.from(group.querySelectorAll(':scope > param'))) {
          if (directChildText(param, 'name').toLowerCase() === 'cond') result.logical = directChildText(param, 'value');
        }
      }
    }
    if (name === 'trigger') {
      for (const group of groups) {
        const values = new Map<string, string>();
        for (const param of Array.from(group.querySelectorAll(':scope > param'))) {
          values.set(directChildText(param, 'name').toLowerCase(), directChildText(param, 'value'));
        }
        const field = values.get('field') || '';
        const operator = values.get('operator') || '';
        const value = values.get('value') || '';
        if (field || operator || value) result.conditions.push({ field, operator, value });
      }
    }
  }
  return result;
}

function parseGraph(details: string, exception = '') {
  const doc = new DOMParser().parseFromString(details, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Workflow Details XML is invalid.');
  const blockElements = Array.from(doc.querySelectorAll('blocks > block'));
  if (!blockElements.length) throw new Error('No workflow blocks were found in the workflow Details XML.');

  const blocks: WorkflowBlock[] = blockElements.map((block) => {
    const id = directChildText(block, 'id');
    const type = directChildText(block, 'type').toLowerCase();
    const title = directChildText(block, 'title') || `${type || 'block'} [${id.slice(0, 8)}]`;
    const exits = Array.from(block.querySelectorAll(':scope > exits > exit')).map((exit) => {
      const exitParams = paramsFor(exit);
      const condition = exitParams.map((p) => `${p.name}=${p.value}`).join(' · ');
      const links = Array.from(exit.querySelectorAll(':scope > links > link, :scope > link'))
        .map((link) => directChildText(link, 'blockId') || directChildText(link, 'destinationBlockId') || directChildText(link, 'targetBlockId'))
        .filter(Boolean);
      return { title: directChildText(exit, 'title') || directChildText(exit, 'name') || 'exit', links, condition };
    });
    return { id, type, title, params: paramsFor(block), exits };
  });

  const byId = new Map(blocks.map((block) => [block.id, block]));
  const edges: WorkflowEdge[] = [];
  const adjacency = new Map<string, string[]>();
  for (const block of blocks) {
    const next: string[] = [];
    for (const exit of block.exits) {
      for (const targetId of exit.links) {
        next.push(targetId);
        edges.push({
          sourceId: block.id,
          sourceTitle: block.title,
          exit: exit.title,
          targetId,
          targetTitle: byId.get(targetId)?.title || `block ${targetId.slice(0, 8)}`
        });
      }
    }
    adjacency.set(block.id, next);
  }

  const startIds = blocks.filter((block) => block.type === 'start').map((block) => block.id);
  const reachable = new Set<string>();
  const queue = [...startIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of adjacency.get(id) || []) if (!reachable.has(next)) queue.push(next);
  }

  const defects: string[] = [];
  if (exception) defects.push(exception);
  for (const block of blocks) {
    if (!reachable.has(block.id) || !['quickaction', 'update'].includes(block.type)) continue;
    for (const exit of block.exits) {
      if (['ok', 'success', 'completed'].includes(exit.title.toLowerCase()) && exit.links.length === 0) {
        defects.push(`${block.title} has a reachable unconnected ${exit.title} exit.`);
      }
    }
  }

  const titleList = (types: string[]) => blocks.filter((b) => types.includes(b.type)).map((b) => b.title);
  return {
    blocks,
    edges,
    derived: {
      starts: blocks.filter((b) => b.type === 'start').length,
      stops: blocks.filter((b) => b.type === 'stop').length,
      tasks: titleList(['task']),
      joins: titleList(['join']),
      branches: titleList(['if', 'switch', 'decision']),
      actions: titleList(['quickaction', 'update', 'invokeworkflow']),
      waits: titleList(['wait', 'waitfor', 'waitstatus', 'waitforstatus']),
      approvals: titleList(['approval']),
      reachable: reachable.size,
      defects: [...new Set(defects)]
    }
  };
}

function parseOuterXml(text: string, sourceFile: string): ParsedWorkflow {
  const outer = new DOMParser().parseFromString(text, 'application/xml');
  if (outer.querySelector('parsererror')) throw new Error('The file is not valid XML.');
  const workflowDefinition = outer.querySelector('WorkflowDefinition');
  if (!workflowDefinition) throw new Error('WorkflowDefinition was not found.');
  const workflowType = outer.querySelector('WorkflowType');
  const details = directChildText(workflowDefinition, 'Details');
  if (!details) throw new Error('Workflow Details are empty.');
  const triggerText = directChildText(workflowDefinition, 'TriggerDetails');
  const graph = parseGraph(details);

  const quickActions: QuickAction[] = Array.from(outer.querySelectorAll('QuickActions > QuickAction')).map((qa) => {
    const rawDefinition = directChildText(qa, 'Definition');
    return {
      id: directChildText(qa, 'Id'),
      objectId: directChildText(qa, 'ObjectId'),
      name: directChildText(qa, 'Name'),
      actionType: directChildText(qa, 'ActionType'),
      groupName: directChildText(qa, 'GroupName'),
      definition: safeQuickActionDefinition(rawDefinition),
      rawDefinition
    };
  });

  const versionMatch = sourceFile.match(/(?:_Version_|Version[_ -]?)(\d+)/i);
  return {
    source: 'ivanti-workflow-export',
    sourceFile,
    capturedAt: new Date().toISOString(),
    workflow: {
      name: directChildText(workflowDefinition, 'Name') || directChildText(workflowType || workflowDefinition, 'Name') || sourceFile,
      displayName: workflowType ? directChildText(workflowType, 'DisplayName') : '',
      description: workflowType ? directChildText(workflowType, 'Description') : '',
      objectType: workflowType ? directChildText(workflowType, 'ObjectType') : '',
      version: versionMatch?.[1] || '',
      status: '',
      exception: '',
      blocks: graph.blocks,
      edges: graph.edges,
      trigger: parseTrigger(triggerText),
      quickActions,
      derived: graph.derived
    }
  };
}

function parseGetInstance(text: string, sourceFile: string): ParsedWorkflow {
  const parsed = JSON.parse(text) as { d?: Record<string, unknown> };
  const payload = parsed.d;
  if (!payload) throw new Error('The JSON does not contain an Ivanti GetInstance d payload.');
  const details = typeof payload.Details === 'string' ? payload.Details : '';
  if (!details) throw new Error('GetInstance Details are empty.');
  const exception = clean(payload.Exception);
  const graph = parseGraph(details, exception);
  return {
    source: 'ivanti-getinstance',
    sourceFile,
    capturedAt: new Date().toISOString(),
    workflow: {
      name: clean(payload.Name) || sourceFile,
      displayName: clean(payload.Name),
      description: '',
      objectType: clean(payload.ContextBO),
      version: clean(payload.Version),
      status: clean(payload.Status),
      exception,
      blocks: graph.blocks,
      edges: graph.edges,
      trigger: { events: { created: false, updated: false, deleted: false }, logical: '', conditions: [] },
      quickActions: [],
      derived: graph.derived
    }
  };
}

async function parseFile(file: File): Promise<ParsedWorkflow> {
  const text = await file.text();
  if (/\.json$/i.test(file.name) || text.trim().startsWith('{')) return parseGetInstance(text, file.name);
  return parseOuterXml(text, file.name);
}

export default function WorkflowXmlImportMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [workflows, setWorkflows] = useState<ParsedWorkflow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const findSettings = () => {
      const panels = [...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];
      const settings = panels.find((panel) => panel.querySelector('h1')?.textContent?.trim() === 'Migration settings') || null;
      setTarget((current) => current === settings ? current : settings);
    };
    findSettings();
    const observer = new MutationObserver(findSettings);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const normalizedJson = useMemo(() => JSON.stringify({
    source: 'ivanti-workflow-batch',
    capturedAt: new Date().toISOString(),
    count: workflows.length,
    workflows
  }, null, 2), [workflows]);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    const ok: ParsedWorkflow[] = [];
    const failed: string[] = [];
    for (const file of Array.from(files)) {
      try {
        ok.push(await parseFile(file));
      } catch (error) {
        failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setWorkflows(ok);
    setErrors(failed);
  }

  async function copyBatch() {
    if (!workflows.length) return;
    await navigator.clipboard.writeText(normalizedJson);
  }

  if (!target) return null;

  return createPortal(
    <section style={{ marginTop: 24, border: '1px solid #dfe1e6', borderRadius: 8, padding: 20, background: '#fff' }} data-ivanti-workflow-xml-panel="true">
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Workflow source</div>
      <h2 style={{ margin: '5px 0 4px' }}>Ivanti Workflow XML Import</h2>
      <p style={{ margin: 0, color: '#626f86' }}>
        Import one or many Ivanti workflow XML exports at once. The analyser preserves the source graph, triggers, branches, joins and embedded Quick Actions. Ivanti GetInstance JSON is also accepted for runtime-only workflows such as definitions discovered through Workflow Instances.
      </p>
      <div style={{ marginTop: 16 }}>
        <input type="file" accept=".xml,.json,text/xml,application/xml,application/json" multiple onChange={(event) => void onFiles(event.target.files)} />
      </div>

      {workflows.length > 0 && (
        <>
          <div style={{ marginTop: 18, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{workflows.length} workflow{workflows.length === 1 ? '' : 's'} analysed</strong>
            <button style={{ background: '#f1f2f4', color: '#172b4d' }} onClick={() => void copyBatch()}>Copy normalized workflow batch JSON</button>
          </div>
          <div style={{ marginTop: 12, border: '1px solid #dfe1e6', borderRadius: 6, overflow: 'hidden' }}>
            {workflows.map((item) => {
              const w = item.workflow;
              return (
                <div key={`${item.sourceFile}-${w.name}`} style={{ padding: 12, borderBottom: '1px solid #f1f2f4' }}>
                  <strong>{w.name}{w.version ? ` · v${w.version}` : ''}</strong>
                  <div style={{ marginTop: 4, fontSize: 12, color: '#626f86' }}>{w.objectType || 'Object type not supplied'} · {item.sourceFile}</div>
                  <div style={{ marginTop: 7, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', gap: 8, fontSize: 13 }}>
                    <span><strong>{w.blocks.length}</strong> blocks</span>
                    <span><strong>{w.derived.tasks.length}</strong> tasks</span>
                    <span><strong>{w.derived.branches.length}</strong> branches</span>
                    <span><strong>{w.derived.joins.length}</strong> joins</span>
                    <span><strong>{w.quickActions.length}</strong> Quick Actions</span>
                    <span><strong>{w.trigger.conditions.length}</strong> trigger conditions</span>
                    <span><strong>{w.derived.defects.length}</strong> defects</span>
                  </div>
                </div>
              );
            })}
          </div>
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Normalized workflow batch JSON</summary>
            <textarea readOnly value={normalizedJson} style={{ width: '100%', boxSizing: 'border-box', minHeight: 280, marginTop: 8, padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }} />
          </details>
        </>
      )}

      {errors.length > 0 && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 4, background: '#ffebe6', color: '#ae2a19' }}>
          <strong>{errors.length} file{errors.length === 1 ? '' : 's'} could not be parsed</strong>
          {errors.map((error) => <div key={error} style={{ marginTop: 5 }}>{error}</div>)}
        </div>
      )}
    </section>,
    target
  );
}
