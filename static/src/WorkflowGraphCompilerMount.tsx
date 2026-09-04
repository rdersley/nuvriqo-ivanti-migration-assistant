import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParsedWorkflow } from './WorkflowXmlImportMount';
import { compileIvantiGraph, type CompiledOrchestrationGraph } from './ivantiGraphCompiler';

type Service = { id: string; analysis?: { serviceName?: string }; ivantiWorkflows?: ParsedWorkflow[] };
type Project = { services?: Service[] };
type CompiledService = { serviceId: string; serviceName: string; graph: CompiledOrchestrationGraph };

const PROJECT_KEY = 'ivanti-migration-assistant-project-v3';
const GRAPH_KEY = 'ivanti-migration-assistant-orchestration-graphs-v2';

function readProject(): Project {
  try { return JSON.parse(localStorage.getItem(PROJECT_KEY) || '{}') as Project; } catch { return {}; }
}

export default function WorkflowGraphCompilerMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [project, setProject] = useState<Project>(() => readProject());

  useEffect(() => {
    const refresh = () => setProject(readProject());
    const find = () => {
      const panels = [...document.querySelectorAll<HTMLElement>('section.panel.fullPanel')];
      setTarget(panels.find((panel) => panel.querySelector('h1')?.textContent?.trim() === 'Migration settings') || null);
    };
    refresh(); find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('ivanti-migration-project-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      observer.disconnect();
      window.removeEventListener('ivanti-migration-project-changed', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const compiled = useMemo<CompiledService[]>(() => {
    const result: CompiledService[] = [];
    for (const service of project.services || []) {
      for (const workflow of service.ivantiWorkflows || []) {
        result.push({
          serviceId: service.id,
          serviceName: service.analysis?.serviceName || service.id,
          graph: compileIvantiGraph(workflow)
        });
      }
    }
    return result;
  }, [project]);

  useEffect(() => {
    if (!compiled.length) return;
    localStorage.setItem(GRAPH_KEY, JSON.stringify({ compiledAt: new Date().toISOString(), services: compiled }));
    window.dispatchEvent(new CustomEvent('ivanti-orchestration-graphs-changed', { detail: { services: compiled } }));
  }, [compiled]);

  if (!target || !compiled.length) return null;

  return createPortal(
    <section style={{ marginTop: 24, border: '1px solid #dfe1e6', borderRadius: 8, padding: 20, background: '#fff' }} data-graph-compiler-panel="true">
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Automation migration</div>
      <h2 style={{ margin: '5px 0 4px' }}>Ivanti process graph compiler</h2>
      <p style={{ margin: 0, color: '#626f86' }}>The imported Ivanti process is now compiled from its real connected graph. Task outcomes, joins, decisions, waits, actions and stop nodes are preserved as executable orchestration semantics rather than being converted into Jira statuses.</p>
      <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
        {compiled.map(({ serviceId, serviceName, graph }) => {
          const count = (kind: string) => graph.nodes.filter((node) => node.kind === kind).length;
          return <article key={`${serviceId}-${graph.workflowName}-${graph.workflowVersion}`} style={{ border: '1px solid #dfe1e6', borderRadius: 7, padding: 12 }}>
            <strong>{serviceName}</strong>
            <div style={{ marginTop: 3, color: '#626f86', fontSize: 12 }}>{graph.workflowName}{graph.workflowVersion ? ` · v${graph.workflowVersion}` : ''} · {graph.transitions.length} connected routes</div>
            <div style={{ marginTop: 9, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 6, fontSize: 12 }}>
              <span><strong>{count('task')}</strong> task/create blocks</span>
              <span><strong>{count('gate')}</strong> gates</span>
              <span><strong>{count('decision')}</strong> decisions</span>
              <span><strong>{count('wait')}</strong> waits</span>
              <span><strong>{count('action')}</strong> actions</span>
              <span><strong>{count('approval')}</strong> approvals</span>
            </div>
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Outcome routes</summary>
              <div style={{ display: 'grid', gap: 5, marginTop: 7, fontSize: 12 }}>
                {graph.transitions.map((edge, index) => <div key={`${edge.sourceId}-${edge.outcome}-${edge.targetId}-${index}`}><strong>{edge.sourceTitle}</strong> — {edge.outcome.toUpperCase()} → {edge.targetTitle}{edge.condition ? ` · ${edge.condition}` : ''}</div>)}
              </div>
            </details>
            {graph.defects.length > 0 && <div style={{ marginTop: 10, padding: 8, background: '#ffebe6', color: '#ae2a19', borderRadius: 5, fontSize: 12 }}><strong>{graph.defects.length} source/compiler item{graph.defects.length === 1 ? '' : 's'} require review.</strong> Unsupported or broken source routes are retained instead of guessed.</div>}
          </article>;
        })}
      </div>
    </section>, target
  );
}
