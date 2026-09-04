from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

needle = r'''      const conditionedDesign = {
        ...enrichedDesign,
        ...(storedDesignForConditions ?? {}),
        sections: conditionedSections,
        conditions: advancedConditions
      };'''

replacement = r'''      // Preserve the newly-built layout/questions as authoritative. Re-merging
      // Jira's previously persisted design here can silently restore stale
      // question placement (for example moving Computer Required? below its
      // dependent hidden section). Only non-topology metadata is carried forward.
      const {
        layout: _staleLayout,
        questions: _staleQuestions,
        sections: _staleSections,
        conditions: _staleConditions,
        ...safePersistedMetadata
      } = (storedDesignForConditions ?? {}) as any;

      const conditionedDesign = {
        ...safePersistedMetadata,
        ...enrichedDesign,
        sections: conditionedSections,
        conditions: advancedConditions
      };'''

if needle not in source:
    raise SystemExit('Expected conditionedDesign block was not found for persisted topology protection')

source = source.replace(needle, replacement, 1)
path.write_text(source)
