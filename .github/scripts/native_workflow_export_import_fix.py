from pathlib import Path

p = Path('static/src/workflowInstanceCompat.ts')
s = p.read_text()
anchor = "document.addEventListener('change', (event) => {"
pos = s.find(anchor)
if pos < 0:
    raise SystemExit('workflow import listener anchor not found')

replacement = r'''document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement | null;
  if (!input || input.type !== 'file' || !input.files?.length) return;

  if (input.dataset.ivantiCompatBypass === '1') {
    delete input.dataset.ivantiCompatBypass;
    return;
  }

  const files = Array.from(input.files);
  const candidateFiles = files.filter((file) => /\.(xml|rox|json)$/i.test(file.name));
  if (candidateFiles.length < 2) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  void (async () => {
    try {
      const loaded = await Promise.all(files.map(async (file) => ({ file, text: await file.text() })));
      const workflowEntries = loaded
        .map((entry) => ({ ...entry, workflow: extractWorkflowPayload(entry.text) }))
        .filter((entry): entry is typeof entry & { workflow: WorkflowPayload } => !!entry.workflow);
      const offeringEntries = loaded.filter(({ file, text }) => /\.(xml|rox)$/i.test(file.name) && !extractWorkflowPayload(text));

      // Nothing to bundle: allow the app's normal single-file import path to handle it.
      if (!workflowEntries.length || !offeringEntries.length) {
        const transfer = new DataTransfer();
        files.forEach((file) => transfer.items.add(file));
        input.files = transfer.files;
        input.dataset.ivantiCompatBypass = '1';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }

      const normalise = (value: string) => value
        .toLowerCase()
        .replace(/\.(xml|rox|json)$/i, '')
        .replace(/\b(workflow|request offering|offering|export|version)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const workflowName = (entry: (typeof workflowEntries)[number]) =>
        clean(entry.workflow.metadata.Name) || entry.file.name.replace(/\.(xml|json)$/i, '');

      const scorePair = (offering: (typeof offeringEntries)[number], workflow: (typeof workflowEntries)[number]) => {
        const offeringName = serviceNameFromXml(offering.text) || offering.file.name.replace(/\.(xml|rox)$/i, '');
        const left = normalise(offeringName);
        const right = normalise(workflowName(workflow));
        if (left && right && left === right) return 100;
        if (left && right && (left.includes(right) || right.includes(left))) return 90;
        const a = new Set(left.split(' ').filter(Boolean));
        const b = new Set(right.split(' ').filter(Boolean));
        const overlap = [...a].filter((token) => b.has(token)).length;
        return overlap ? Math.round((overlap / Math.max(a.size, b.size)) * 80) : 0;
      };

      const remainingWorkflows = [...workflowEntries];
      const outputFiles: File[] = [];
      const pairedOfferingFiles = new Set<File>();
      const pairedWorkflowFiles = new Set<File>();

      for (const offering of offeringEntries) {
        if (!remainingWorkflows.length) break;
        const ranked = remainingWorkflows
          .map((workflow) => ({ workflow, score: scorePair(offering, workflow) }))
          .sort((a, b) => b.score - a.score);

        // If there is only one offering/workflow pair, accept it even when the exported
        // filenames differ. In bulk imports require a reasonable name match.
        const best = ranked[0];
        const singlePair = offeringEntries.length === 1 && workflowEntries.length === 1;
        if (!best || (!singlePair && best.score < 45)) continue;

        const bundle = bundleServiceAndWorkflow(offering.text, offering.file.name, best.workflow.workflow);
        const offeringName = serviceNameFromXml(offering.text) || offering.file.name.replace(/\.(xml|rox)$/i, '');
        const mergedName = `${offeringName} - with workflow.xml`;
        outputFiles.push(new File([bundle], mergedName, { type: 'application/xml', lastModified: Date.now() }));
        pairedOfferingFiles.add(offering.file);
        pairedWorkflowFiles.add(best.workflow.file);
        const index = remainingWorkflows.indexOf(best.workflow);
        if (index >= 0) remainingWorkflows.splice(index, 1);
      }

      // Keep unmatched files so a user can still inspect/import them independently.
      for (const { file } of loaded) {
        if (!pairedOfferingFiles.has(file) && !pairedWorkflowFiles.has(file)) outputFiles.push(file);
      }

      if (!outputFiles.length) throw new Error('No Ivanti request-offering/workflow pairs could be matched.');

      const transfer = new DataTransfer();
      outputFiles.forEach((file) => transfer.items.add(file));
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
'''

p.write_text(s[:pos] + replacement)
print('Applied native Ivanti workflow XML import support')
