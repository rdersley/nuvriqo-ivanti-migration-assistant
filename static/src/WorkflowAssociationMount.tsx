import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParsedWorkflow } from './WorkflowXmlImportMount';

type ServiceLite = { id: string; analysis?: { serviceName?: string }; ivantiWorkflows?: ParsedWorkflow[]; updatedAt?: string };
type ProjectLite = { services?: ServiceLite[]; updatedAt?: string };
type Association = {
  workflowKey: string;
  serviceId: string;
  serviceName: string;
  workflowName: string;
  score: number;
  reason: string;
  confirmed: boolean;
};

const PROJECT_KEY = 'ivanti-migration-assistant-project-v3';
const WORKFLOW_LIBRARY_KEY = 'ivanti-migration-assistant-workflow-library-v1';
const ASSOCIATION_KEY = 'ivanti-migration-assistant-workflow-associations-v1';

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value: string): Set<string> {
  return new Set(norm(value).split(/\s+/).filter((token) => token.length > 2));
}

function keyOf(item: ParsedWorkflow): string {
  return [item.source, item.workflow.objectType, item.workflow.name, item.workflow.version, item.sourceFile].map((value) => norm(String(value || ''))).join('|');
}

function scoreMatch(workflow: ParsedWorkflow, serviceName: string): { score: number; reason: string } {
  const service = norm(serviceName);
  const names = [workflow.workflow.name, workflow.workflow.displayName].map(norm).filter(Boolean);
  if (names.some((name) => name === service)) return { score: 100, reason: 'Exact workflow/service name match' };
  if (names.some((name) => name.includes(service) || service.includes(name))) return { score: 88, reason: 'Workflow and service names strongly overlap' };

  const triggerValues = workflow.workflow.trigger.conditions.map((condition) => norm(condition.value)).filter(Boolean);
  if (triggerValues.some((value) => value === service || value.includes(service) || service.includes(value))) {
    return { score: 94, reason: 'Workflow trigger value matches the service/request name' };
  }

  const serviceTokens = tokens(service);
  let best = 0;
  for (const name of names) {
    const workflowTokens = tokens(name);
    const union = new Set([...serviceTokens, ...workflowTokens]);
    const overlap = [...serviceTokens].filter((token) => workflowTokens.has(token)).length;
    best = Math.max(best, union.size ? Math.round((overlap / union.size) * 75) : 0);
  }
  return { score: best, reason: best >= 50 ? 'Name tokens overlap' : 'No reliable automatic match' };
}

function readProject(): ProjectLite {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    return raw ? JSON.parse(raw) as ProjectLite : {};
  } catch { return {}; }
}

function readWorkflows(): ParsedWorkflow[] {
  try {
    const raw = localStorage.getItem(WORKFLOW_LIBRARY_KEY);
    return raw ? JSON.parse(raw) as ParsedWorkflow[] : [];
  } catch { return []; }
}

function readAssociations(): Association[] {
  try {
    const raw = localStorage.getItem(ASSOCIATION_KEY);
    return raw ? JSON.parse(raw) as Association[] : [];
  } catch { return []; }
}

function writeProjectWorkflow(workflow: ParsedWorkflow, serviceId: string): ProjectLite {
  const project = readProject();
  const now = new Date().toISOString();
  const updated: ProjectLite = {
    ...project,
    updatedAt: now,
    services: (project.services || []).map((service) => {
      if (service.id !== serviceId) return service;
      const current = service.ivantiWorkflows || [];
      const map = new Map(current.map((item) => [keyOf(item), item]));
      map.set(keyOf(workflow), workflow);
      return { ...service, ivantiWorkflows: [...map.values()], updatedAt: now };
    })
  };
  localStorage.setItem(PROJECT_KEY, JSON.stringify(updated));
  window.dispatchEvent(new CustomEvent('ivanti-migration-project-changed', { detail: { project: updated } }));
  return updated;
}

function semanticCounts(workflow: ParsedWorkflow) {
  const childQuickActions = workflow.workflow.quickActions.filter((action) => action.semantic?.kind === 'child-work-item').length;
  const emails = workflow.workflow.quickActions.filter((action) => action.semantic?.kind === 'email').length;
  return {
    childWork: workflow.workflow.derived.tasks.length + childQuickActions,
    approvals: workflow.workflow.derived.approvals.length,
    gates: workflow.workflow.derived.joins.length,
    branches: workflow.workflow.derived.branches.length,
    notifications: emails,
    automation: workflow.workflow.derived.actions.length + workflow.workflow.derived.waits.length,
    defects: workflow.workflow.derived.defects.length
  };
}

export default function WorkflowAssociationMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [project, setProject] = useState<ProjectLite>(() => readProject());
  const [workflows, setWorkflows] = useState<ParsedWorkflow[]>(() => readWorkflows());
  const [associations, setAssociations] = useState<Association[]>(() => readAssociations());

  useEffect(() => {
    const refresh = () => {
      setProject(readProject());
      setWorkflows(readWorkflows());
      setAssociations(readAssociations());
    };
    const findSettings = () => {
      const panels = [...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];
      const settings = panels.find((panel) => panel.querySelector('h1')?.textContent?.trim() === 'Migration settings') || null;
      setTarget((current) => current === settings ? current : settings);
    };
    findSettings();
    const observer = new MutationObserver(findSettings);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('ivanti-workflow-library-changed', refresh);
    window.addEventListener('ivanti-migration-project-changed', refresh);
    window.addEventListener('storage', refresh);
    const interval = window.setInterval(() => setProject(readProject()), 1500);
    return () => {
      observer.disconnect();
      window.removeEventListener('ivanti-workflow-library-changed', refresh);
      window.removeEventListener('ivanti-migration-project-changed', refresh);
      window.removeEventListener('storage', refresh);
      window.clearInterval(interval);
    };
  }, []);

  const suggestions = useMemo(() => workflows.map((workflow) => {
    const existing = associations.find((item) => item.workflowKey === keyOf(workflow));
    if (existing) return { workflow, association: existing };
    let best: Association | null = null;
    for (const service of project.services || []) {
      const serviceName = service.analysis?.serviceName || '';
      if (!serviceName) continue;
      const scored = scoreMatch(workflow, serviceName);
      if (!best || scored.score > best.score) {
        best = {
          workflowKey: keyOf(workflow),
          serviceId: service.id,
          serviceName,
          workflowName: workflow.workflow.name,
          score: scored.score,
          reason: scored.reason,
          confirmed: false
        };
      }
    }
    return { workflow, association: best };
  }), [workflows, project.services, associations]);

  function saveAssociation(workflow: ParsedWorkflow, serviceId: string, scoreOverride?: number, reasonOverride?: string) {
    const service = (project.services || []).find((item) => item.id === serviceId);
    if (!service) return;
    const serviceName = service.analysis?.serviceName || 'Service';
    const scored = scoreMatch(workflow, serviceName);
    const next: Association = {
      workflowKey: keyOf(workflow),
      serviceId,
      serviceName,
      workflowName: workflow.workflow.name,
      score: scoreOverride ?? scored.score,
      reason: reasonOverride ?? scored.reason,
      confirmed: true
    };
    setAssociations((current) => {
      const updated = [...current.filter((item) => item.workflowKey !== next.workflowKey), next];
      localStorage.setItem(ASSOCIATION_KEY, JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('ivanti-workflow-associations-changed', { detail: { associations: updated } }));
      return updated;
    });
    setProject(writeProjectWorkflow(workflow, serviceId));
  }

  function acceptSuggestion(workflow: ParsedWorkflow, association: Association) {
    saveAssociation(workflow, association.serviceId, association.score, association.reason);
  }

  useEffect(() => {
    // Exact name matches are safe enough to persist automatically. This is especially
    // useful for runtime-only GetInstance workflows such as New Employee Setup v52.
    const exact = suggestions.filter(({ association }) => association && !association.confirmed && association.score === 100);
    if (!exact.length) return;
    for (const { workflow, association } of exact) {
      if (association) saveAssociation(workflow, association.serviceId, association.score, association.reason);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions]);

  if (!target || !workflows.length) return null;

  const confident = suggestions.filter(({ association }) => association && association.score >= 85).length;
  const confirmed = associations.filter((item) => item.confirmed).length;

  return createPortal(
    <section style={{ marginTop: 24, border: '1px solid #dfe1e6', borderRadius: 8, padding: 20, background: '#fff' }} data-workflow-association-panel="true">
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Migration design</div>
      <h2 style={{ margin: '5px 0 4px' }}>Workflow → Jira service mapping</h2>
      <p style={{ margin: 0, color: '#626f86' }}>Match imported Ivanti workflows to the request/service they implement. Exact names are linked automatically; uncertain matches stay for review rather than being guessed. Confirmed workflows are stored on the migration service so the Jira build can use the actual Ivanti orchestration.</p>
      <div style={{ marginTop: 12, fontSize: 13, color: '#44546f' }}><strong>{workflows.length}</strong> workflows · <strong>{confident}</strong> strong automatic matches · <strong>{confirmed}</strong> confirmed mappings</div>

      <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
        {suggestions.map(({ workflow, association }) => {
          const counts = semanticCounts(workflow);
          const existing = association?.confirmed;
          return (
            <div key={keyOf(workflow)} style={{ border: '1px solid #dfe1e6', borderRadius: 6, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div><strong>{workflow.workflow.name}{workflow.workflow.version ? ` · v${workflow.workflow.version}` : ''}</strong><div style={{ color: '#626f86', fontSize: 12, marginTop: 3 }}>{workflow.workflow.objectType || 'Unknown object'} · {workflow.source === 'ivanti-getinstance' ? 'runtime workflow' : 'workflow export'}</div></div>
                <div style={{ fontSize: 12, color: counts.defects ? '#ae2a19' : '#164b35' }}>{counts.defects ? `${counts.defects} source defect${counts.defects === 1 ? '' : 's'}` : 'Source graph valid'}</div>
              </div>

              <div style={{ marginTop: 9, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(125px,1fr))', gap: 6, fontSize: 12, color: '#44546f' }}>
                <span>{counts.childWork} child work items</span><span>{counts.approvals} approvals</span><span>{counts.gates} automation gates</span><span>{counts.branches} branches</span><span>{counts.notifications} notifications</span><span>{counts.automation} other automation steps</span>
              </div>

              <div style={{ marginTop: 11, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={existing ? association?.serviceId || '' : ''} onChange={(event) => event.target.value && saveAssociation(workflow, event.target.value)} style={{ padding: '7px 9px', minWidth: 250 }}>
                  <option value="">Select target migration service…</option>
                  {(project.services || []).map((service) => <option key={service.id} value={service.id}>{service.analysis?.serviceName || service.id}</option>)}
                </select>
                {!existing && association && association.score >= 50 && <button onClick={() => acceptSuggestion(workflow, association)}>Use suggested: {association.serviceName}</button>}
                {association && <span style={{ fontSize: 12, color: '#626f86' }}>{existing ? 'Confirmed and stored on service' : `Suggestion ${association.score}%`} · {association.reason}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </section>, target
  );
}
