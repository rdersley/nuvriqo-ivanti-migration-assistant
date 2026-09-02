// Compatibility layer for Ivanti Neurons / ISM workflow instance captures.
//
// The existing migration parser consumes XML. Ivanti's workflow instance viewer,
// however, returns JSON from Workflow.asmx/GetInstance with the actual workflow
// graph stored as escaped XML in d.Details. This shim unwraps that payload before
// the normal parser sees it and enriches workflow blocks with the metadata the
// existing parser already understands.

const NativeDOMParser = window.DOMParser;

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function directText(parent: Element, selector: string): string {
  return clean(parent.querySelector(selector)?.textContent || '');
}

function parameterValue(block: Element, name: string): string {
  for (const param of Array.from(block.querySelectorAll('blockProperties param'))) {
    const paramName = directText(param, ':scope > name');
    if (paramName.toLowerCase() === name.toLowerCase()) {
      return directText(param, ':scope > value');
    }
  }
  return '';
}

function annotateWorkflowDocument(document: XMLDocument): XMLDocument {
  const blocks = Array.from(document.querySelectorAll('blocks > block'));

  for (const block of blocks) {
    const type = directText(block, ':scope > type');
    const title = directText(block, ':scope > title');
    if (type) block.setAttribute('type', type);
    if (title) block.setAttribute('displayName', title);

    const team = parameterValue(block, 'team');
    const assignee = parameterValue(block, 'assignee');
    if (team) block.setAttribute('team', team);
    else if (assignee) block.setAttribute('assignee', assignee);

    const field = parameterValue(block, 'field');
    const operator = parameterValue(block, 'operator');
    const value = parameterValue(block, 'value');
    const condition = [field, operator, value].filter(Boolean).join(' ');
    if (condition && ['if', 'switch', 'decision'].includes(type.toLowerCase())) {
      block.setAttribute('condition', condition);
    }

    const details = parameterValue(block, 'details');
    if (details) block.setAttribute('description', details.slice(0, 500));
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
  add('IvantiWorkflowStatus', payload.Status);

  const exception = clean(payload.Exception);
  if (exception) {
    const warning = document.createElement('workflowValidationError');
    warning.setAttribute('displayName', 'Ivanti source workflow validation error');
    warning.setAttribute('description', exception.slice(0, 1000));
    root.appendChild(warning);
  }
}

function unwrapIvantiWorkflow(input: string, mimeType: DOMParserSupportedType): string | null {
  if (mimeType !== 'application/xml' && mimeType !== 'text/xml') return null;
  const trimmed = input.trim();

  // Workflow instance viewer response: { d: { Details: "<scenario ...>" } }
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { d?: Record<string, unknown> };
      const payload = parsed?.d;
      const details = typeof payload?.Details === 'string' ? payload.Details.trim() : '';
      if (details && /<(scenario|workflow)\b/i.test(details)) {
        const native = new NativeDOMParser();
        const document = native.parseFromString(details, 'application/xml');
        if (!document.querySelector('parsererror')) {
          appendMetadata(document, payload || {});
          annotateWorkflowDocument(document);
          return new XMLSerializer().serializeToString(document);
        }
      }
    } catch {
      // Let the normal XML parser report a useful import error.
    }
    return null;
  }

  // Ivanti workflow-version exports sometimes wrap the real workflow XML inside
  // WorkflowDefinition/Details as escaped text. Unwrap only that known shape so
  // normal ROX/request-offering imports are unaffected.
  if (/<WorkflowVersionExport\b/i.test(trimmed)) {
    try {
      const native = new NativeDOMParser();
      const wrapper = native.parseFromString(trimmed, 'application/xml');
      const details = wrapper.querySelector('WorkflowDefinition > Details')?.textContent?.trim() || '';
      if (details && /<(scenario|workflow)\b/i.test(details)) {
        const document = native.parseFromString(details, 'application/xml');
        if (!document.querySelector('parsererror')) {
          const name = wrapper.querySelector('WorkflowDefinition > Name')?.textContent?.trim();
          if (name) appendMetadata(document, { Name: name });
          annotateWorkflowDocument(document);
          return new XMLSerializer().serializeToString(document);
        }
      }
    } catch {
      // Fall through to the existing XML parser.
    }
  }

  return null;
}

class IvantiAwareDOMParser extends NativeDOMParser {
  parseFromString(input: string, mimeType: DOMParserSupportedType): Document {
    const unwrapped = unwrapIvantiWorkflow(input, mimeType);
    const document = super.parseFromString(unwrapped || input, mimeType) as XMLDocument;
    if (!document.querySelector('parsererror')) annotateWorkflowDocument(document);
    return document;
  }
}

// Install before App is loaded. This keeps the compatibility change isolated and
// lets parseIvantiXml continue handling existing ROX/XML files unchanged.
window.DOMParser = IvantiAwareDOMParser as typeof DOMParser;
