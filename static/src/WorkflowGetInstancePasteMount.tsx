import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseGetInstance, type ParsedWorkflow } from './WorkflowXmlImportMount';

const WORKFLOW_LIBRARY_KEY = 'ivanti-migration-assistant-workflow-library-v1';

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function workflowKey(item: ParsedWorkflow): string {
  return [item.source, item.workflow.objectType, item.workflow.name, item.workflow.version, item.sourceFile]
    .map(clean)
    .join('|')
    .toLowerCase();
}

function readLibrary(): ParsedWorkflow[] {
  try {
    const raw = localStorage.getItem(WORKFLOW_LIBRARY_KEY);
    return raw ? JSON.parse(raw) as ParsedWorkflow[] : [];
  } catch {
    return [];
  }
}

function saveWorkflow(workflow: ParsedWorkflow): ParsedWorkflow[] {
  const current = readLibrary();
  const map = new Map(current.map((item) => [workflowKey(item), item]));
  map.set(workflowKey(workflow), workflow);
  const updated = [...map.values()].sort((a, b) =>
    a.workflow.name.localeCompare(b.workflow.name) || a.workflow.version.localeCompare(b.workflow.version)
  );
  localStorage.setItem(WORKFLOW_LIBRARY_KEY, JSON.stringify(updated));
  window.dispatchEvent(new CustomEvent('ivanti-workflow-library-changed', { detail: { workflows: updated } }));
  return updated;
}

export default function WorkflowGetInstancePasteMount() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [json, setJson] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const findTarget = () => {
      const xmlPanel = document.querySelector<HTMLElement>('[data-ivanti-workflow-xml-panel="true"]');
      setTarget((current) => current === xmlPanel ? current : xmlPanel);
    };
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  function importJson() {
    const text = json.trim();
    if (!text) {
      setStatus({ ok: false, text: 'Paste the GetInstance Response JSON first.' });
      return;
    }
    try {
      const workflow = parseGetInstance(text, 'GetInstance pasted response.json');
      const library = saveWorkflow(workflow);
      setStatus({
        ok: true,
        text: `Imported ${workflow.workflow.name}${workflow.workflow.version ? ` v${workflow.workflow.version}` : ''}. Workflow library now contains ${library.length} workflow${library.length === 1 ? '' : 's'}. Exact service-name matches will link automatically.`
      });
      setJson('');
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!target) return null;

  return createPortal(
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #dfe1e6' }} data-getinstance-paste-import="true">
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', color: '#44546f', textTransform: 'uppercase' }}>Runtime workflow capture</div>
      <h3 style={{ margin: '5px 0 4px' }}>Paste GetInstance Response JSON</h3>
      <p style={{ margin: '0 0 10px', color: '#626f86' }}>For runtime-only workflows such as New Employee Setup, paste the full DevTools GetInstance Response here. No file needs to be created.</p>
      <textarea
        value={json}
        onChange={(event) => setJson(event.target.value)}
        placeholder='Paste the full JSON response containing the "d" payload here…'
        style={{ width: '100%', minHeight: 170, boxSizing: 'border-box', padding: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', border: '1px solid #8590a2', borderRadius: 5 }}
      />
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={importJson} disabled={!json.trim()}>Import GetInstance workflow</button>
        <span style={{ color: '#626f86', fontSize: 12 }}>Parses the real Ivanti workflow graph and stores it in the migration workflow library.</span>
      </div>
      {status && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 4, background: status.ok ? '#dcfff1' : '#ffebe6', color: status.ok ? '#164b35' : '#ae2a19' }}>
          {status.text}
        </div>
      )}
    </div>,
    target
  );
}
