// Final semantic cleanup for combined Ivanti request-offering + GetInstance imports.
// Keeps request-offering fields isolated from workflow implementation metadata and
// prevents graph edges from being mistaken for Jira lifecycle transitions.

const SemanticBaseDOMParser = window.DOMParser;

function tidy(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isWorkflowDocument(document: XMLDocument): boolean {
  return Boolean(
    document.querySelector('IvantiMigrationBundle WorkflowSource') ||
    document.querySelector('scenario > blocks, workflow > blocks')
  );
}

function cleanupWorkflowSemantics(document: XMLDocument): XMLDocument {
  if (!isWorkflowDocument(document)) return document;

  // workflowLink nodes were useful while proving graph extraction, but the v6
  // migration engine interprets anything link-shaped as a parent Jira workflow
  // transition. Preserve the route as evidence on the source block, then remove
  // the synthetic link node so fulfilment orchestration is not shown as
  // "Unknown source -> Unknown target" lifecycle transitions.
  const blocks = Array.from(document.querySelectorAll('blocks > block'));
  const byId = new Map<string, Element>();
  for (const block of blocks) {
    const id = tidy(block.getAttribute('data-ivanti-block-id')) || tidy(block.querySelector(':scope > id')?.textContent);
    if (id) byId.set(id, block);
  }

  for (const link of Array.from(document.querySelectorAll('workflowLink'))) {
    const sourceId = tidy(link.getAttribute('sourceId') || link.getAttribute('fromId'));
    const label = tidy(link.getAttribute('displayName'));
    const source = byId.get(sourceId);
    if (source && label) {
      const current = tidy(source.getAttribute('description'));
      const route = `Route: ${label}`;
      if (!current.includes(route)) source.setAttribute('description', [current, route].filter(Boolean).join(' | ').slice(0, 3000));
    }
    link.remove();
  }

  // Ivanti task/decision properties use generic <param> elements. The original
  // request-offering parser deliberately treats parameter-like XML as potential
  // form fields, which caused workflow properties to inflate 31 real request
  // fields to 46. Relevant workflow values have already been promoted to block
  // attributes by workflowInstanceCompat (team, condition, description, IDs), so
  // remove only workflow-side params after enrichment. RequestOfferingSource is
  // untouched and remains the sole source of Jira custom-field candidates.
  const workflowRoots = Array.from(document.querySelectorAll('IvantiMigrationBundle > WorkflowSource'));
  if (workflowRoots.length) {
    for (const root of workflowRoots) {
      for (const param of Array.from(root.querySelectorAll('param, parameter'))) param.remove();
    }
  } else {
    for (const param of Array.from(document.querySelectorAll('blocks param, blocks parameter'))) param.remove();
  }

  // Explicit marker consumed as harmless source evidence and useful in exported
  // implementation packs. This states the intended Jira semantic model: the
  // parent request keeps a compact lifecycle while Ivanti task/join/decision
  // blocks are implemented as fulfilment orchestration/automation.
  const root = document.documentElement;
  if (root && !document.querySelector('IvantiWorkflowSemanticModel')) {
    const marker = document.createElement('IvantiWorkflowSemanticModel');
    marker.textContent = 'fulfilment-orchestration';
    root.appendChild(marker);
  }

  return document;
}

class IvantiSemanticDOMParser extends SemanticBaseDOMParser {
  parseFromString(input: string, mimeType: DOMParserSupportedType): Document {
    const document = super.parseFromString(input, mimeType) as XMLDocument;
    if (!document.querySelector('parsererror')) cleanupWorkflowSemantics(document);
    return document;
  }
}

window.DOMParser = IvantiSemanticDOMParser as typeof DOMParser;
