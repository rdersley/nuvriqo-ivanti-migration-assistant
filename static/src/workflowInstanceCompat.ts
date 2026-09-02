// Compatibility layer for Ivanti Neurons / ISM workflow exports.
//
// Ivanti's workflow instance viewer returns JSON from Workflow.asmx/GetInstance
// with the actual workflow graph stored as escaped XML in d.Details. The main
// migration parser consumes XML, so this layer unwraps the JSON, enriches the
// workflow graph with useful semantic metadata, and can combine a normal
// request-offering XML/ROX export with a matching GetInstance JSON capture when
// both files are selected together.

const NativeDOMParser = window.DOMParser;

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function directText(parent: Element, selector: string): string {
  return clean(parent.querySelector(selector)?.textContent || '');
}

function firstDirectText(parent: Element, selectors: string[]): string {
  for (const selector of selectors) {
    const value = directText(parent, selector);
    if (value) return value;
  }
  return '';
}

function parameterValue(block: Element, names: string | string[]): string {
  const wanted = (Array.isArray(names) ? names : [names]).map((name) => name.toLowerCase());
  for (const param of Array.from(block.querySelectorAll('param'))) {
    const paramName = firstDirectText(param, [':scope > name', ':scope > Name']).toLowerCase();
    if (wanted.includes(paramName)) {
      return firstDirectText(param, [':scope > value', ':scope > Value']);
    }
  }
  return '';
}

function blockId(block: Element): string {
  return firstDirectText(block, [':scope > id', ':scope > Id', ':scope > ID']);
}

function blockType(block: Element): string {
  return firstDirectText(block, [':scope > type', ':scope > Type']).toLowerCase();
}

function blockTitle(block: Element): string {
  return firstDirectText(block, [':scope > title', ':scope > Title']);
}

function semanticType(type: string, title: string): string {
  const lowerTitle = title.toLowerCase();
  if (['if', 'switch', 'decision', 'join'].includes(type)) return `condition ${type}`;
  if (type === 'task') return 'task';
  if (type === 'approval') return 'approval';
  if (type === 'quickaction' && /notify|notification|email|message/.test(lowerTitle)) return 'notification quickaction';
  if (type === 'quickaction') return 'activity quickaction';
  if (type === 'update') return 'activity update';
  if (type === 'invokeworkflow') return 'activity invoked workflow';
  return `activity ${type || 'block'}`;
}

function exitLinks(exit: Element): Element[] {
  const direct = Array.from(exit.querySelectorAll(':scope > links > link'));
  if (direct.length) return direct;
  return Array.from(exit.querySelectorAll('link'));
}

function destinationId(link: Element): string {
  return firstDirectText(link, [
    ':scope > blockId', ':scope > BlockId', ':scope > destinationBlockId',
    ':scope > targetBlockId', ':scope > target', ':scope > Target'
  ]);
}

function exitTitle(exit: Element): string {
  return firstDirectText(exit, [':scope > title', ':scope > Title', ':scope > name', ':scope > Name']);
}

function exitCondition(exit: Element): string {
  const direct = firstDirectText(exit, [':scope > condition', ':scope > Condition', ':scope > expression', ':scope > Expression']);
  if (direct) return direct;
  const field = parameterValue(exit, ['field', 'Field']);
  const operator = parameterValue(exit, ['operator', 'Operator']);
  const value = parameterValue(exit, ['value', 'Value']);
  return [field, operator, value].filter(Boolean).join(' ');
}

function makeEvidenceNode(document: XMLDocument, root: Element, tag: string, label: string, attrs: Record<string, string> = {}): void {
  const node = document.createElement(tag);
  node.setAttribute('displayName', label);
  for (const [key, value] of Object.entries(attrs)) {
    if (value) node.setAttribute(key, value);
  }
  root.appendChild(node);
}

function annotateWorkflowDocument(document: XMLDocument): XMLDocument {
  const blocks = Array.from(document.querySelectorAll('blocks > block'));
  const root = document.documentElement;
  if (!root || !blocks.length) return document;

  const byId = new Map<string, Element>();
  const edges = new Map<string, string[]>();

  for (const block of blocks) {
    const id = blockId(block);
    if (id) byId.set(id, block);
  }

  for (const block of blocks) {
    const id = blockId(block);
    const originalType = blockType(block);
    const originalTitle = blockTitle(block);
    const shortId = id ? id.slice(0, 8) : 'unknown';
    const title = originalTitle || (originalType === 'quickaction' ? `Unnamed Quick Action [${shortId}]` : `${originalType || 'Workflow'} block [${shortId}]`);

    block.setAttribute('data-ivanti-block-type', originalType);
    block.setAttribute('type', semanticType(originalType, title));
    block.setAttribute('displayName', title);
    if (id) block.setAttribute('data-ivanti-block-id', id);

    const team = parameterValue(block, ['team', 'assignment team', 'owner team']);
    const assignee = parameterValue(block, ['assignee', 'owner']);
    if (team) block.setAttribute('team', team);
    else if (assignee) block.setAttribute('assignee', assignee);

    const field = parameterValue(block, ['field', 'fieldname']);
    const operator = parameterValue(block, ['operator']);
    const value = parameterValue(block, ['value']);
    const condition = [field, operator, value].filter(Boolean).join(' ');
    if (condition && ['if', 'switch', 'decision'].includes(originalType)) {
      block.setAttribute('condition', condition);
    }

    const details = parameterValue(block, ['details', 'detail', 'description']);
    const summary = parameterValue(block, ['summary', 'subject']);
    const taskType = parameterValue(block, ['tasktype', 'task type', 'type']);
    const priority = parameterValue(block, ['priority']);
    const dueDate = parameterValue(block, ['duedate', 'due date', 'duration', 'duedateduration']);
    const description = [summary, details, taskType && `Task type: ${taskType}`, priority && `Priority: ${priority}`, dueDate && `Due: ${dueDate}`]
      .filter(Boolean)
      .join(' | ');
    if (description) block.setAttribute('description', description.slice(0, 1500));

    const qaId = parameterValue(block, ['qaid', 'quickactionid', 'quick action id']);
    const invokedWorkflowId = parameterValue(block, ['workflowid', 'workflow id']);
    if (qaId) block.setAttribute('data-ivanti-quick-action-id', qaId);
    if (invokedWorkflowId) block.setAttribute('data-ivanti-invoked-workflow-id', invokedWorkflowId);

    const destinations: string[] = [];
    const exits = Array.from(block.querySelectorAll(':scope > exits > exit'));
    for (const exit of exits) {
      const exitName = exitTitle(exit) || 'exit';
      const conditionText = exitCondition(exit);
      for (const link of exitLinks(exit)) {
        const targetId = destinationId(link);
        if (!targetId) continue;
        destinations.push(targetId);
        const targetTitle = blockTitle(byId.get(targetId) || document.createElement('block')) || `block ${targetId.slice(0, 8)}`;
        makeEvidenceNode(document, root, 'workflowLink', `${title} — ${exitName} → ${targetTitle}`, {
          sourceId: id,
          targetId,
          fromId: id,
          toId: targetId,
          condition: conditionText
        });
      }
    }
    if (id) edges.set(id, destinations);
  }

  // Calculate reachability from start blocks so that we only flag dangerous
  // unconnected action exits that can actually execute.
  const starts = blocks.filter((block) => blockType(block) === 'start').map(blockId).filter(Boolean);
  const reachable = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const next of edges.get(id) || []) if (!reachable.has(next)) queue.push(next);
  }

  for (const block of blocks) {
    const id = blockId(block);
    const originalType = blockType(block);
    if (!id || !reachable.has(id) || !['quickaction', 'update'].includes(originalType)) continue;
    const title = blockTitle(block) || `Unnamed ${originalType === 'quickaction' ? 'Quick Action' : 'Update'} [${id.slice(0, 8)}]`;
    for (const exit of Array.from(block.querySelectorAll(':scope > exits > exit'))) {
      const exitName = exitTitle(exit).toLowerCase();
      const links = exitLinks(exit);
      if (links.length) continue;
      if (!['ok', 'success', 'completed'].includes(exitName)) continue;
      makeEvidenceNode(document, root, 'condition', `SOURCE DEFECT — ${title} has an unconnected ${exitTitle(exit) || 'success'} exit`, {
        condition: 'Reachable non-waiting action exit is not connected to another block.'
      });
    }
  }

  return document;
}

function appendMetadata(document: XMLDocument, payload: Record<string, unknown>): void {
  const root = document.documentElement;
  if (!root) return;

  const add = (tag: string, value: unknown) => {
    const text = clean(value);
    if (!text || document.querySelector(tag)) return;
    const node = document.createElement(tag);
    node.textContent = text;
    root.appendChild(node);
  };

  add('ServiceReqTemplateName', payload.Name);
  add('IvantiWorkflowVersion', payload.Version);
  add('IvantiWorkflowInstanceId', payload.RecId);
  add('IvantiWorkflowContextBO', payload.ContextBO);
  add('IvantiWorkflowStatus', payload.Status);

  const exception = clean(payload.Exception);
  if (exception) {
    makeEvidenceNode(document, root, 'condition', 'SOURCE DEFECT — Ivanti workflow instance reported a failure', {
      condition: exception.slice(0, 1500)
    });
  }
}

type WorkflowPayload = {
  details: string;
  metadata: Record<string, unknown>;
};

function extractWorkflowPayload(input: string): WorkflowPayload | null {
  const trimmed = input.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { d?: Record<string, unknown> };
      const payload = parsed?.d;
      const details = typeof payload?.Details === 'string' ? payload.Details.trim() : '';
      if (details && /<(scenario|workflow)\b/i.test(details)) {
        return { details, metadata: payload || {} };
      }
    } catch {
      return null;
    }
  }

  if (/<WorkflowVersionExport\b/i.test(trimmed)) {
    const native = new NativeDOMParser();
    const wrapper = native.parseFromString(trimmed, 'application/xml');
    if (wrapper.querySelector('parsererror')) return null;
    const details = wrapper.querySelector('WorkflowDefinition > Details')?.textContent?.trim() || '';
    if (!details || !/<(scenario|workflow)\b/i.test(details)) return null;
    const name = wrapper.querySelector('WorkflowDefinition > Name')?.textContent?.trim() || '';
    return { details, metadata: { Name: name } };
  }

  return null;
}

function unwrapIvantiWorkflow(input: string, mimeType: DOMParserSupportedType): string | null {
  if (mimeType !== 'application/xml' && mimeType !== 'text/xml') return null;
  const extracted = extractWorkflowPayload(input);
  if (!extracted) return null;

  const native = new NativeDOMParser();
  const document = native.parseFromString(extracted.details, 'application/xml');
  if (document.querySelector('parsererror')) return null;
  appendMetadata(document, extracted.metadata);
  annotateWorkflowDocument(document);
  return new XMLSerializer().serializeToString(document);
}

function serviceNameFromXml(input: string): string {
  const native = new NativeDOMParser();
  const document = native.parseFromString(input, 'application/xml');
  if (document.querySelector('parsererror')) return '';
  const selectors = [
    'ServiceReqTemplateName', 'ServiceRequestName', 'OfferingName',
    'ServiceOfferingName', 'RequestOfferingName'
  ];
  for (const selector of selectors) {
    const value = clean(document.querySelector(selector)?.textContent || '');
    if (value) return value;
  }
  return '';
}

function bundleServiceAndWorkflow(serviceText: string, serviceFileName: string, workflow: WorkflowPayload): string {
  const native = new NativeDOMParser();
  const serviceDoc = native.parseFromString(serviceText, 'application/xml');
  if (serviceDoc.querySelector('parsererror')) throw new Error(`${serviceFileName} is not valid XML/ROX.`);

  const workflowDoc = native.parseFromString(workflow.details, 'application/xml');
  if (workflowDoc.querySelector('parsererror')) throw new Error('The GetInstance workflow Details value is not valid XML.');
  appendMetadata(workflowDoc, workflow.metadata);
  annotateWorkflowDocument(workflowDoc);

  const bundleDoc = native.parseFromString('<IvantiMigrationBundle/>', 'application/xml') as XMLDocument;
  const root = bundleDoc.documentElement;

  const sourceName = serviceNameFromXml(serviceText) || clean(workflow.metadata.Name) || serviceFileName.replace(/\.(xml|rox)$/i, '');
  const nameNode = bundleDoc.createElement('ServiceReqTemplateName');
  nameNode.textContent = sourceName;
  root.appendChild(nameNode);

  const offering = bundleDoc.createElement('RequestOfferingSource');
  offering.appendChild(bundleDoc.importNode(serviceDoc.documentElement, true));
  root.appendChild(offering);

  const workflowNode = bundleDoc.createElement('WorkflowSource');
  workflowNode.appendChild(bundleDoc.importNode(workflowDoc.documentElement, true));
  root.appendChild(workflowNode);

  return new XMLSerializer().serializeToString(bundleDoc);
}

class IvantiAwareDOMParser extends NativeDOMParser {
  parseFromString(input: string, mimeType: DOMParserSupportedType): Document {
    const unwrapped = unwrapIvantiWorkflow(input, mimeType);
    const document = super.parseFromString(unwrapped || input, mimeType) as XMLDocument;
    if (!document.querySelector('parsererror')) annotateWorkflowDocument(document);
    return document;
  }
}

window.DOMParser = IvantiAwareDOMParser as typeof DOMParser;

// If the user selects the normal request-offering XML/ROX and its GetInstance
// JSON together, turn them into a single synthetic XML source before React sees
// the input event. This gives the app one service containing both the 31 request
// fields/form data and the exact Ivanti workflow graph instead of two duplicate
// services.
document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement | null;
  if (!input || input.type !== 'file' || !input.files?.length) return;

  if (input.dataset.ivantiCompatBypass === '1') {
    delete input.dataset.ivantiCompatBypass;
    return;
  }

  const files = Array.from(input.files);
  const hasJson = files.some((file) => /\.json$/i.test(file.name));
  const hasOffering = files.some((file) => /\.(xml|rox)$/i.test(file.name));
  if (!hasJson || !hasOffering) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  void (async () => {
    try {
      const loaded = await Promise.all(files.map(async (file) => ({ file, text: await file.text() })));
      const workflowEntry = loaded.find(({ text }) => extractWorkflowPayload(text));
      const offeringEntry = loaded.find(({ file, text }) => /\.(xml|rox)$/i.test(file.name) && !extractWorkflowPayload(text));
      if (!workflowEntry || !offeringEntry) throw new Error('Select one request-offering XML/ROX file and one GetInstance JSON file.');

      const workflow = extractWorkflowPayload(workflowEntry.text)!;
      const bundle = bundleServiceAndWorkflow(offeringEntry.text, offeringEntry.file.name, workflow);
      const mergedName = offeringEntry.file.name.replace(/\.(xml|rox)$/i, '') + ' - with workflow.xml';
      const mergedFile = new File([bundle], mergedName, { type: 'application/xml', lastModified: Date.now() });

      const transfer = new DataTransfer();
      transfer.items.add(mergedFile);
      input.files = transfer.files;
      input.dataset.ivantiCompatBypass = '1';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      console.error('Ivanti workflow bundle import failed', error);
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));
      input.files = transfer.files;
      input.dataset.ivantiCompatBypass = '1';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })();
}, true);
