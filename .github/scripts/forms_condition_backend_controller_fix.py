from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

old = r'''      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerResolved = resolved.find((item) =>
        String(item.sourceId ?? '') === String(condition.controllerFieldId) ||
        normaliseStatusName(item.name) === normaliseStatusName(controllerField?.name)
      );'''

new = r'''      const conditionTargetSourceIds = new Set(
        (condition.targetFieldIds ?? []).map((value: unknown) => String(value))
      );

      let controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );

      // Ivanti exports can occasionally point controllerFieldId at the first field
      // inside the conditional block itself. When that happens, recover the
      // controller from the matching non-conditional source section instead of
      // passing the corrupt relationship through to Jira Forms.
      const controllerIsTarget = controllerField
        ? conditionTargetSourceIds.has(String(controllerField.sourceId ?? ''))
        : false;

      if (!controllerField || controllerIsTarget) {
        const conditionalSection = sections.find((section: any) => {
          const ids = Array.isArray(section?.fieldIds)
            ? section.fieldIds.map((value: unknown) => String(value))
            : [];
          return ids.some((id: string) => conditionTargetSourceIds.has(id));
        });

        const conditionalName = String(conditionalSection?.name ?? '');
        const baseName = conditionalName
          .replace(/\s*[—-]\s*conditional\s*$/i, '')
          .trim();

        const baseSection = sections.find((section: any) => {
          const sectionName = String(section?.name ?? '')
            .replace(/\s*[—-]\s*conditional\s*$/i, '')
            .trim();
          return sectionName &&
            normaliseStatusName(sectionName) === normaliseStatusName(baseName) &&
            !/conditional\s*$/i.test(String(section?.name ?? ''));
        });

        const baseIds = Array.isArray(baseSection?.fieldIds)
          ? baseSection.fieldIds.map((value: unknown) => String(value))
          : [];

        const candidates = baseIds
          .map((id: string) => fields.find((field) => String(field.sourceId ?? '') === id))
          .filter((field): field is JsmFieldInput => Boolean(field))
          .filter((field) => !conditionTargetSourceIds.has(String(field.sourceId ?? '')))
          .filter((field) => formQuestionType(field.jiraType) === 'cd');

        const preferred = candidates.find((field) =>
          /required\??|requested\??|shipping|service\s*desk/i.test(String(field.name ?? ''))
        ) || candidates[0];

        if (preferred) controllerField = preferred;
      }

      if (!controllerField || conditionTargetSourceIds.has(String(controllerField.sourceId ?? ''))) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `Conditional controller could not be safely resolved outside its target fields. Original controller: ${String(condition.controllerFieldId ?? 'unknown')}.`
        });
        continue;
      }

      const controllerResolved = resolved.find((item) =>
        String(item.sourceId ?? '') === String(controllerField?.sourceId ?? '') ||
        normaliseStatusName(item.name) === normaliseStatusName(controllerField?.name)
      );'''

if old not in source:
    raise SystemExit('Expected controller resolution block was not found after Forms patches')

source = source.replace(old, new, 1)
path.write_text(source)
