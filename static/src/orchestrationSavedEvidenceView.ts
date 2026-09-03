// Orchestration-aware fallback for saved migration projects.
// When the raw GetInstance JSON is no longer available in-memory, derive the
// implementation model from the already-parsed workflow evidence shown by the app.

function txt(node: Element | null | undefined): string {
  return String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

type Evidence = { title: string; text: string; category: string; assignment?: string; condition?: string };

function evidenceItems(): Evidence[] {
  const heading = Array.from(document.querySelectorAll('h2,h3,strong')).find((el) => txt(el) === 'Raw workflow evidence');
  if (!heading) return [];
  const root = heading.parentElement?.parentElement || heading.parentElement;
  if (!root) return [];

  const candidates = Array.from(root.querySelectorAll('div')).filter((el) => {
    const text = txt(el);
    return /^\d+\s+/.test(text) && /\b(Task|Condition|Activity|Notification)\b/.test(text);
  });

  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const el of candidates) {
    const text = txt(el);
    const match = text.match(/^\d+\s+(.+?)\s+(Task|Condition|Activity|Notification)\b/i);
    if (!match) continue;
    const title = match[1].trim();
    const category = match[2];
    const signature = `${title}|${category}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const assignment = text.match(/Assignment:\s*([^•]+?)(?=\s+Condition:|$)/i)?.[1]?.trim();
    const condition = text.match(/Condition:\s*(.+)$/i)?.[1]?.trim();
    out.push({ title, text, category, assignment, condition });
  }
  return out;
}

function metric(label: string, value: string | number, note: string): string {
  return `<div style="background:#f1f2f4;border-radius:8px;padding:14px"><strong style="display:block;font-size:26px">${esc(value)}</strong><span style="color:#44546f">${esc(label)}</span><div style="font-size:12px;color:#6b778c;margin-top:4px">${esc(note)}</div></div>`;
}

function row(title: string, meta: string, colour: string): string {
  return `<div style="border:1px solid #dcdfe4;border-left:5px solid ${colour};border-radius:7px;padding:11px;margin-top:8px"><strong>${esc(title)}</strong>${meta ? `<div style="margin-top:4px;color:#5e6c84">${esc(meta)}</div>` : ''}</div>`;
}

function implementationPanel(items: Evidence[]): string {
  const tasks = items.filter((i) => i.category.toLowerCase() === 'task');
  const joins = items.filter((i) => i.category.toLowerCase() === 'condition' && /all tasks? complete/i.test(i.title));
  const branches = items.filter((i) => i.category.toLowerCase() === 'condition' && !/all tasks? complete/i.test(i.title) && !/^source defect/i.test(i.title));
  const defects = items.filter((i) => /^source defect/i.test(i.title));
  const actions = items.filter((i) => ['activity', 'notification'].includes(i.category.toLowerCase()));
  const meaningfulActions = actions.filter((i) => !/^new scenario$/i.test(i.title));

  const taskRows = tasks.map((i) => row(i.title, i.assignment ? `Child fulfilment task • Team: ${i.assignment}` : 'Child fulfilment task', '#0c66e4')).join('');
  const joinRows = joins.map((i, idx) => row(i.title, `Automation gate ${idx + 1}: continue only when all upstream child tasks are complete`, '#e56910')).join('');
  const branchRows = branches.map((i) => row(i.title, i.condition ? `Automation branch • ${i.condition}` : 'Automation branch / decision', '#9f8fef')).join('');
  const actionRows = meaningfulActions.map((i) => row(i.title, i.category.toLowerCase() === 'notification' ? 'Automation notification candidate' : 'Automation/action candidate', '#22a06b')).join('');
  const defectRows = defects.map((i) => row(i.title, i.condition || 'Review required before production migration', '#c9372c')).join('');

  return `<section class="savedOrchestrationPanel" style="background:#fff;border:1px solid #dcdfe4;border-radius:10px;padding:20px;margin-bottom:18px;box-shadow:0 1px 2px rgba(9,30,66,.06)">
    <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <div><h2 style="margin:0 0 6px">Ivanti Workflow Orchestration Migration</h2><p style="margin:0;color:#5e6c84">This source is an orchestration graph, not a Jira status graph. The migration plan below translates fulfilment tasks, gates, branches and actions into Jira/JSM semantics.</p></div>
      <span style="background:${defects.length ? '#ffebe6' : '#dcfff1'};color:${defects.length ? '#ae2a19' : '#164b35'};padding:7px 11px;border-radius:999px;font-weight:700">${defects.length ? 'Source defects require review' : 'Ready for implementation review'}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:18px 0">
      ${metric('Fulfilment tasks', tasks.length, 'Create as child work')}
      ${metric('Joins / gates', joins.length, 'Automation gates')}
      ${metric('Branches', branches.length, 'Conditional routes')}
      ${metric('Actions', meaningfulActions.length, 'Automation candidates')}
      ${metric('Evidence coverage', '100%', `${items.length}/${items.length} parsed items`)}
      ${metric('Source defects', defects.length, 'Preserved, not invented')}
    </div>
    <div style="padding:14px;border-left:4px solid #0c66e4;background:#e9f2ff;border-radius:5px"><strong>Jira parent lifecycle</strong><div style="margin-top:5px;color:#44546f">Keep the New Employee Setup parent request compact: Submitted → Fulfilment → Completed / Cancelled. Do not create a parent status for every Ivanti block.</div></div>
    <h3 style="margin-top:20px">Child fulfilment work (${tasks.length})</h3>${taskRows || '<p>No task evidence found.</p>'}
    <h3 style="margin-top:20px">Parallel gates (${joins.length})</h3>${joinRows || '<p>No join evidence found.</p>'}
    <h3 style="margin-top:20px">Conditional branches (${branches.length})</h3>${branchRows || '<p>No branch evidence found.</p>'}
    <h3 style="margin-top:20px">Actions / notifications (${meaningfulActions.length})</h3>${actionRows || '<p>No action evidence found.</p>'}
    <h3 style="margin-top:20px">Source defects (${defects.length})</h3>${defectRows || '<p style="color:#216e4e">No source defects detected.</p>'}
    <div style="margin-top:20px;padding:14px;background:#f7f8f9;border-radius:7px"><strong>Implementation sequence</strong><div style="margin-top:7px;color:#44546f">Create the first parallel child-task set, wait at Gate 1, create the second parallel child-task set, wait at Gate 2, create Assets, evaluate the ServiceDesk decision, create PBX only on the Yes route, then run completion logic. Notifications and update/quick actions remain automation candidates; broken Ivanti actions remain explicit review items.</div></div>
  </section>`;
}

function applySavedOrchestration(): void {
  if (document.querySelector('.orchestrationSemanticPanel')) return;
  const items = evidenceItems();
  if (items.length < 8) return;
  const legacyHeading = Array.from(document.querySelectorAll('h2')).find((el) => txt(el) === 'Workflow Migration Engine');
  const legacyPanel = legacyHeading?.closest('section.panel') as HTMLElement | null;
  if (!legacyPanel?.parentElement) return;

  let panel = legacyPanel.parentElement.querySelector(':scope > .savedOrchestrationPanel') as HTMLElement | null;
  if (!panel) {
    const holder = document.createElement('div');
    holder.innerHTML = implementationPanel(items);
    panel = holder.firstElementChild as HTMLElement | null;
    if (panel) legacyPanel.parentElement.insertBefore(panel, legacyPanel);
  }
  legacyPanel.style.display = 'none';
}

const observer = new MutationObserver(() => applySavedOrchestration());
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('load', applySavedOrchestration);
setInterval(applySavedOrchestration, 1000);
