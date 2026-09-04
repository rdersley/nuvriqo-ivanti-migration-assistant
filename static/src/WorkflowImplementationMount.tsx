import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParsedWorkflow } from './WorkflowXmlImportMount';

type Service = {
  id: string;
  analysis?: { serviceName?: string };
  ivantiWorkflows?: ParsedWorkflow[];
};
type Project = { services?: Service[] };

type WorkItem = {
  title: string;
  summary?: string;
  details?: string;
  team?: string;
  due?: string;
};

type BranchItem = {
  title: string;
  condition: string;
};

type ActionItem = {
  title: string;
  type: string;
  detail: string;
};

type Blueprint = {
  serviceId: string;
  serviceName: string;
  workflowName: string;
  workflowVersion: string;
  source: string;
  parentLifecycle: string[];
  workItems: WorkItem[];
  joins: string[];
  branches: BranchItem[];
  actions: ActionItem[];
  defects: string[];
};

const PROJECT_KEY = 'ivanti-migration-assistant-project-v3';
const BLUEPRINT_KEY = 'ivanti-migration-assistant-orchestration-blueprints-v1';

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function readProject(): Project {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    return raw ? JSON.parse(raw) as Project : {};
  } catch {
    return {};
  }
}

function param(block: ParsedWorkflow['workflow']['blocks'][number], ...names: string[]): string {
  const wanted = names.map((name) => name.toLowerCase());
  const match = block.params.find((item) => wanted.includes(clean(item.name).toLowerCase()));
  return clean(match?.value);
}

function conditionFor(block: ParsedWorkflow['workflow']['blocks'][number]): string {
  const field = param(block, 'field', 'fieldname');
  const operator = param(block, 'operator');
  const value = param(block, 'value');
  return [field, operator, value].filter(Boolean).join(' ');
}

function actionDetail(block: ParsedWorkflow['workflow']['blocks'][number]): string {
  if (block.type === 'invokeworkflow') {
    const workflow = param(block, 'workflow', 'workflowid', 'workflow id');
    const wait = param(block, 'waitforcompletion');
    return [workflow && `Workflow ${workflow}`, wait && `wait=${wait}`].filter(Boolean).join(' · ');
  }
  const qa = param(block, 'qaid', 'quickactionid', 'quick action id');
  return qa ? `Quick Action ${qa}` : 'Automation action captured from Ivanti workflow';
}

function buildBlueprint(service: Service, workflow: ParsedWorkflow): Blueprint {
  const blocks = workflow.workflow.blocks;
  const workItems = blocks.filter((block) => block.type === 'task').map((block) => ({
    title: block.title,
    summary: param(block, 'summary', 'subject') || undefined,
    details: param(block, 'details', 'detail', 'description') || undefined,
    team: param(block, 'team', 'assignment team', 'owner team') || undefined,
    due: (() => {
      const days = param(block, 'duedatedays');
      const field = param(block, 'duedatefield');
      return days ? `${days} day${days === '1' ? '' : 's'}` : field ? `Source field: ${field}` : undefined;
    })()
  }));

  const branches = blocks.filter((block) => ['if', 'switch', 'decision'].includes(block.type)).map((block) => ({
    title: block.title,
    condition: conditionFor(block) || 'Conditional route captured from Ivanti workflow'
  }));

  const actions = blocks.filter((block) => ['quickaction', 'update', 'invokeworkflow', 'approval'].includes(block.type)).map((block) => ({
    title: block.title,
    type: block.type,
    detail: actionDetail(block)
  }));

  return {
    serviceId: service.id,
    serviceName: clean(service.analysis?.serviceName) || 'Service',
    workflowName: workflow.workflow.name,
    workflowVersion: workflow.workflow.version,
    source: workflow.source,
    parentLifecycle: ['Submitted', 'Fulfilment', 'Completed', 'Cancelled'],
    workItems,
    joins: blocks.filter((block) => block.type === 'join').map((block) => block.title),
    branches,
    actions,
    defects: workflow.workflow.derived.defects
  };
}

function saveBlueprints(blueprints: Blueprint[]) {
  localStorage.setItem(BLUEPRINT_KEY, JSON.stringify({ generatedAt: new Date().toISOString(), blueprints }));
  window.dispatchEvent(new CustomEvent('ivanti-orchestration-blueprints-changed', { detail: { blueprints } }));
}

export default function WorkflowImplementationMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [project, setProject] = useState<Project>(() => readProject());

  useEffect(() => {
    const refresh = () => setProject(readProject());
    const findTarget = () => {
      const panels = [...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];
      const settings = panels.find((panel) => panel.querySelector('h1')?.textContent?.trim() === 'Migration settings') || null;
      setTarget((current) => current === settings ? current : settings);
    };
    refresh();
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('ivanti-migration-project-changed', refresh);
    window.addEventListener('storage', refresh);
    const timer = window.setInterval(refresh, 1500);
    return () => {
      observer.disconnect();
      window.removeEventListener('ivanti-migration-project-changed', refresh);
      window.removeEventListener('storage', refresh);
      window.clearInterval(timer);
    };
  }, []);

  const blueprints = useMemo(() => {
    const result: Blueprint[] = [];
    for (const service of project.services || []) {
      for (const workflow of service.ivantiWorkflows || []) result.push(buildBlueprint(service, workflow));
    }
    return result;
  }, [project]);

  useEffect(() => {
    if (blueprints.length) saveBlueprints(blueprints);
  }, [blueprints]);

  if (!target || !blueprints.length) return null;

  return createPortal(
    <section style={{ marginTop: 24, border: '1px solid #dfe1e6', borderRadius: 8, padding: 20, background: '#fff' }} data-orchestration-implementation-panel="true">
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Jira implementation</div>
      <h2 style={{ margin: '5px 0 4px' }}>Orchestration implementation blueprint</h2>
      <p style={{ margin: 0, color: '#626f86' }}>Build the Jira design from the confirmed Ivanti workflow graph. Task blocks become child fulfilment work, joins become automation gates, decisions become Jira conditions, and workflow actions stay as automation candidates. The parent request lifecycle remains deliberately compact.</p>

      <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
        {blueprints.map((blueprint) => (
          <article key={`${blueprint.serviceId}-${blueprint.workflowName}-${blueprint.workflowVersion}`} style={{ border: '1px solid #dfe1e6', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <strong>{blueprint.serviceName}</strong>
                <div style={{ marginTop: 3, color: '#626f86', fontSize: 12 }}>{blueprint.workflowName}{blueprint.workflowVersion ? ` · v${blueprint.workflowVersion}` : ''} · {blueprint.source === 'ivanti-getinstance' ? 'runtime workflow' : 'workflow export'}</div>
              </div>
              <span style={{ fontSize: 12, color: blueprint.defects.length ? '#ae2a19' : '#164b35' }}>{blueprint.defects.length ? `${blueprint.defects.length} source defect${blueprint.defects.length === 1 ? '' : 's'} retained for review` : 'Source graph ready'}</span>
            </div>

            <div style={{ marginTop: 12, padding: 10, background: '#e9f2ff', borderRadius: 6 }}>
              <strong>Parent Jira lifecycle</strong>
              <div style={{ marginTop: 5 }}>{blueprint.parentLifecycle.join(' → ')}</div>
            </div>

            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8, fontSize: 13 }}>
              <span><strong>{blueprint.workItems.length}</strong> child work items</span>
              <span><strong>{blueprint.joins.length}</strong> gates</span>
              <span><strong>{blueprint.branches.length}</strong> conditions</span>
              <span><strong>{blueprint.actions.length}</strong> automation actions</span>
            </div>

            {blueprint.workItems.length > 0 && <details style={{ marginTop: 12 }} open={blueprint.workItems.length <= 8}><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Child fulfilment work</summary><div style={{ display: 'grid', gap: 7, marginTop: 8 }}>{blueprint.workItems.map((item, index) => <div key={`${item.title}-${index}`} style={{ padding: 9, background: '#f7f8f9', borderRadius: 5 }}><strong>{item.title}</strong><div style={{ marginTop: 3, color: '#626f86', fontSize: 12 }}>{[item.team && `Team: ${item.team}`, item.summary, item.due && `Due: ${item.due}`].filter(Boolean).join(' · ')}</div>{item.details && <div style={{ marginTop: 4, fontSize: 12 }}>{item.details}</div>}</div>)}</div></details>}

            {blueprint.branches.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Conditional routing</summary><div style={{ display: 'grid', gap: 7, marginTop: 8 }}>{blueprint.branches.map((item, index) => <div key={`${item.title}-${index}`} style={{ padding: 9, background: '#fff7f0', borderRadius: 5 }}><strong>{item.title}</strong><div style={{ marginTop: 3, fontSize: 12 }}>{item.condition}</div></div>)}</div></details>}

            {blueprint.joins.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Parallel completion gates</summary><div style={{ marginTop: 8, color: '#44546f', fontSize: 13 }}>{blueprint.joins.join(' · ')}</div></details>}

            {blueprint.actions.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontWeight: 700 }}>Automation candidates</summary><div style={{ display: 'grid', gap: 7, marginTop: 8 }}>{blueprint.actions.map((item, index) => <div key={`${item.title}-${index}`} style={{ padding: 9, background: '#f7f8f9', borderRadius: 5 }}><strong>{item.title}</strong><div style={{ marginTop: 3, color: '#626f86', fontSize: 12 }}>{item.type} · {item.detail}</div></div>)}</div></details>}

            {blueprint.defects.length > 0 && <details style={{ marginTop: 10 }}><summary style={{ cursor: 'pointer', fontWeight: 700, color: '#ae2a19' }}>Source defects requiring migration decision</summary><div style={{ display: 'grid', gap: 7, marginTop: 8 }}>{blueprint.defects.map((defect, index) => <div key={index} style={{ padding: 9, background: '#ffebe6', color: '#ae2a19', borderRadius: 5, fontSize: 12 }}>{defect}</div>)}</div></details>}
          </article>
        ))}
      </div>
    </section>, target
  );
}
