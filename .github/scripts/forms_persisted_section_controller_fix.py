from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

needle = r'''      const conditionedDesign = {
        ...enrichedDesign,
        ...(storedDesignForConditions ?? {}),
        sections: conditionedSections,
        conditions: advancedConditions
      };'''

replacement = r'''      // Final controller repair from Jira's persisted Form topology.
      // The section IDs in Forms map to layout document positions. For each
      // conditional target section, find its matching non-conditional base
      // section, inspect the persisted questions actually placed there, and use
      // the strongest Required?/Requested? choice question as the controller.
      //
      // IMPORTANT: when the controller changes, the Jira option id must also be
      // re-resolved against that repaired controller's Jira field. Reusing the
      // old constraint is what produced a valid field with a blank Value selector
      // (for example Computer Required? paired with Second Monitor's Yes option).
      const persistedDesignForControllerRepair = storedDesignForConditions ?? {};
      const persistedQuestionsForRepair = persistedDesignForControllerRepair.questions ?? {};
      const persistedLayoutForRepair = Array.isArray(persistedDesignForControllerRepair.layout)
        ? persistedDesignForControllerRepair.layout
        : [];
      const sectionEntriesForRepair = Object.entries(conditionedSections ?? {});

      const normaliseSectionNameForRepair = (value: unknown) =>
        String(value ?? '').replace(/\s*[—-]\s*conditional\s*$/i, '').trim().toLowerCase();

      const questionIdsInLayoutDoc = (sectionId: string): string[] => {
        const index = Number(sectionId);
        if (!Number.isFinite(index) || index < 0 || index >= persistedLayoutForRepair.length) return [];
        const doc: any = persistedLayoutForRepair[index];
        const ids: string[] = [];
        const walk = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (node?.type === 'extension' && node?.attrs?.extensionKey === 'question') {
            const id = node?.attrs?.parameters?.id;
            if (id !== undefined && id !== null) ids.push(String(id));
          }
          if (Array.isArray(node)) node.forEach(walk);
          else Object.values(node).forEach(walk);
        };
        walk(doc);
        return ids;
      };

      for (const [conditionId, rawCondition] of Object.entries(advancedConditions)) {
        const condition: any = rawCondition;
        const targetSectionIds = Array.isArray(condition?.o?.sIds) ? condition.o.sIds.map(String) : [];
        if (!targetSectionIds.length) continue;

        let repairedControllerId = '';
        for (const targetSectionId of targetSectionIds) {
          const targetSection: any = (conditionedSections as any)?.[targetSectionId];
          const baseName = normaliseSectionNameForRepair(targetSection?.name);
          if (!baseName) continue;

          const baseEntry = sectionEntriesForRepair.find(([candidateId, rawSection]) => {
            if (String(candidateId) === String(targetSectionId)) return false;
            const candidate: any = rawSection;
            return !/conditional\s*$/i.test(String(candidate?.name ?? '')) &&
              normaliseSectionNameForRepair(candidate?.name) === baseName;
          });
          if (!baseEntry) continue;

          const baseQuestionIds = questionIdsInLayoutDoc(String(baseEntry[0]));
          const candidates = baseQuestionIds
            .map((id) => ({ id, question: (persistedQuestionsForRepair as any)?.[id] }))
            .filter((item) => item.question && String(item.question?.type ?? '') === 'cd')
            .map((item) => {
              const label = String(item.question?.label ?? '');
              let score = 0;
              if (/required\??|requested\??/i.test(label)) score += 100;
              if (/^is\s|^does\s|^do\s/i.test(label)) score += 40;
              return { ...item, score };
            })
            .sort((a, b) => b.score - a.score);

          if (candidates[0]?.id && candidates[0].score > 0) {
            repairedControllerId = String(candidates[0].id);
            break;
          }
        }

        if (!repairedControllerId) continue;

        const repairedQuestion: any = (persistedQuestionsForRepair as any)?.[repairedControllerId];
        const repairedJiraFieldId = String(repairedQuestion?.jiraField ?? '').trim();
        const sourceCondition: any = conditions[Number(conditionId) - 1];
        const desiredValue = String(sourceCondition?.value ?? '').trim();

        let repairedConstraint = '';
        if (repairedJiraFieldId && desiredValue) {
          try {
            const repairedContextId = await getFirstContextId(repairedJiraFieldId);
            const repairedOptionResponse = await api.asUser().requestJira(
              route`/rest/api/3/field/${repairedJiraFieldId}/context/${repairedContextId}/option?maxResults=1000`,
              { headers: { Accept: 'application/json' } }
            );
            const repairedOptionBody = await parseResponse<{ values?: Array<{ id?: string; value?: string }> }>(repairedOptionResponse);
            const wanted = normaliseStatusName(desiredValue);
            const repairedOption = (repairedOptionBody.values ?? []).find((item) =>
              normaliseStatusName(item.value) === wanted
            );
            repairedConstraint = String(repairedOption?.id ?? '').trim();
          } catch (error) {
            unresolvedRules.push({
              id: String(sourceCondition?.id ?? conditionId),
              reason: `Could not re-resolve option '${desiredValue}' for repaired Forms controller ${String(repairedQuestion?.label ?? repairedControllerId)} (${repairedJiraFieldId}): ${error instanceof Error ? error.message : String(error)}`
            });
            continue;
          }
        }

        if (!repairedConstraint) {
          unresolvedRules.push({
            id: String(sourceCondition?.id ?? conditionId),
            reason: `No Jira option matched '${desiredValue}' for repaired Forms controller ${String(repairedQuestion?.label ?? repairedControllerId)} (${repairedJiraFieldId || 'no Jira field'}).`
          });
          continue;
        }

        condition.i.co = { cIds: { [repairedControllerId]: [repairedConstraint] } };
        if (Array.isArray(condition?.i?.groups)) {
          for (const group of condition.i.groups) {
            if (!Array.isArray(group?.checks)) continue;
            for (const check of group.checks) {
              check.fieldId = repairedControllerId;
              check.constraint = [repairedConstraint];
            }
          }
        }
      }

      const conditionedDesign = {
        ...enrichedDesign,
        ...(storedDesignForConditions ?? {}),
        sections: conditionedSections,
        conditions: advancedConditions
      };'''

if needle not in source:
    raise SystemExit('Expected conditionedDesign block was not found for persisted section controller repair')

source = source.replace(needle, replacement, 1)
path.write_text(source)
