from pathlib import Path

path = Path('static/src/safeOrchestrationBuild.ts')
source = path.read_text()

old = """    const conditions = service.proposedConditions || [];
    const sections = prepareConditionalSections(service.formSections || [], conditions);

    const form: any = await invoke('createJsmForm', {"""

new = """    const rawConditions = service.proposedConditions || [];
    const sections = prepareConditionalSections(service.formSections || [], rawConditions);

    // Repair Ivanti condition controllers deterministically from the final section
    // topology that we are about to send to Jira Forms. This avoids trusting a
    // corrupt controllerFieldId when it points at one of the fields being shown.
    const conditions = rawConditions.map((condition: any) => {
      const targetIds = new Set((condition?.targetFieldIds || []).map((id: any) => String(id)));
      const current = fields.find((field: any) => String(field.sourceId ?? '') === String(condition?.controllerFieldId ?? ''));
      if (current && !targetIds.has(String(current.sourceId ?? ''))) return condition;

      const conditionalSection = sections.find((section: any) => {
        if (!/conditional\s*$/i.test(String(section?.name ?? ''))) return false;
        const ids = Array.isArray(section?.fieldIds) ? section.fieldIds.map((id: any) => String(id)) : [];
        return ids.some((id: string) => targetIds.has(id));
      });
      if (!conditionalSection) return condition;

      const baseName = String(conditionalSection.name ?? '').replace(/\s*[—-]\s*conditional\s*$/i, '').trim();
      const baseSection = sections.find((section: any) =>
        !/conditional\s*$/i.test(String(section?.name ?? '')) &&
        String(section?.name ?? '').trim().toLowerCase() === baseName.toLowerCase()
      );
      if (!baseSection) return condition;

      const baseIds = Array.isArray(baseSection?.fieldIds) ? baseSection.fieldIds.map((id: any) => String(id)) : [];
      const candidates = baseIds
        .map((id: string) => fields.find((field: any) => String(field.sourceId ?? '') === id))
        .filter(Boolean)
        .filter((field: any) => !targetIds.has(String(field.sourceId ?? '')))
        .filter((field: any) => ['select', 'checkbox'].includes(String(field.jiraType ?? '').toLowerCase()));

      const preferred = candidates.find((field: any) => /required\??|requested\??|shipping|service\s*desk/i.test(String(field.name ?? ''))) || candidates[0];
      return preferred?.sourceId
        ? { ...condition, controllerFieldId: preferred.sourceId, controllerFieldName: preferred.name }
        : condition;
    });

    const form: any = await invoke('createJsmForm', {"""

if old not in source:
    raise SystemExit('Expected JSM conditions block was not found')

source = source.replace(old, new, 1)
path.write_text(source)
