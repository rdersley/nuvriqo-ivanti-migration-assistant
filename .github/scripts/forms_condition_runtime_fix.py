from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

old = r'''      advancedConditions[conditionId] = {
        i: {
          co: {
            cIds: {
              [controllerQuestionId]: [optionId]
            }
          }
        },
        o: {
          sIds: resolvedTargetSectionIds,
          t: 'sh'
        }
      };'''

new = r'''      // Jira Forms can normalise/re-key linked questions when a template is
      // stored. Conditions must therefore reference the exact question object
      // returned by the form read-back, not our pre-save synthetic question id.
      const storedQuestionsForController = storedDesignForConditions?.questions ?? {};
      const persistedControllerEntry = Object.entries(storedQuestionsForController).find(([, rawQuestion]) => {
        const question = rawQuestion as Record<string, unknown>;
        return String(question?.jiraField ?? '') === jiraFieldId;
      });
      const persistedControllerQuestionId = String(persistedControllerEntry?.[0] ?? '');
      const persistedControllerQuestion = persistedControllerEntry?.[1] as Record<string, unknown> | undefined;

      if (!persistedControllerQuestionId || !persistedControllerQuestion) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `Persisted Forms controller question was not found for Jira field ${jiraFieldId} (${controllerField?.name || condition.controllerFieldId}).`
        });
        continue;
      }

      const persistedControllerLabel = String(persistedControllerQuestion.label ?? '').trim();
      if (!persistedControllerLabel) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `Persisted Forms controller ${persistedControllerQuestionId} has no label for Jira field ${jiraFieldId}.`
        });
        continue;
      }

      // The condition constraint is a Forms choice token, not necessarily the
      // Jira custom-field option id. Resolve the token from the persisted Forms
      // question recursively by matching the visible Ivanti value (for example
      // "Yes"). This avoids Jira rendering a raw option id such as 13058.
      const wantedChoice = normaliseStatusName(desiredValue);
      const seenChoiceNodes = new Set<unknown>();
      const findPersistedChoiceToken = (node: unknown): string | undefined => {
        if (!node || typeof node !== 'object' || seenChoiceNodes.has(node)) return undefined;
        seenChoiceNodes.add(node);
        if (Array.isArray(node)) {
          for (const item of node) {
            const found = findPersistedChoiceToken(item);
            if (found) return found;
          }
          return undefined;
        }

        const record = node as Record<string, unknown>;
        const labels = [record.label, record.name, record.text, record.displayName, record.value]
          .filter((value) => value !== undefined && value !== null)
          .map((value) => String(value));
        if (labels.some((value) => normaliseStatusName(value) === wantedChoice)) {
          for (const key of ['id', 'choiceId', 'key', 'optionId']) {
            const token = record[key];
            if (token !== undefined && token !== null && String(token).trim()) return String(token);
          }
          // Some Forms choice maps use the displayed value as the constraint.
          if (record.value !== undefined && record.value !== null && String(record.value).trim()) {
            return String(record.value);
          }
        }

        for (const value of Object.values(record)) {
          const found = findPersistedChoiceToken(value);
          if (found) return found;
        }
        return undefined;
      };

      const formsChoiceToken = findPersistedChoiceToken(persistedControllerQuestion) || optionId;
      if (!formsChoiceToken) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `Persisted Forms choice token was not found for '${desiredValue}' on ${persistedControllerLabel}.`
        });
        continue;
      }

      advancedConditions[conditionId] = {
        i: {
          // Keep Jira's compatibility map and the documented advanced structure
          // aligned to the same persisted Forms question and choice token.
          co: {
            cIds: {
              [persistedControllerQuestionId]: [formsChoiceToken]
            }
          },
          operator: 'OR',
          groups: [{
            operator: 'AND',
            checks: [{
              fieldId: persistedControllerQuestionId,
              type: 'SOME_OF',
              constraint: [formsChoiceToken]
            }]
          }]
        },
        o: {
          sIds: resolvedTargetSectionIds,
          t: 'sh'
        }
      };'''

if old not in source:
    raise SystemExit('Expected native Forms condition assignment was not found after forms_condition_fix.py')
source = source.replace(old, new, 1)

# Critical fix: once Jira has normalised the form, do not overwrite its stored
# questions/layout with our pre-save enrichedDesign while adding conditions. That
# was leaving conditions pointed at ids which no longer existed in the submitted
# design and caused the Forms editor to display "Unnamed Field".
old_design = r'''      const conditionedDesign = {
        ...enrichedDesign,
        sections: conditionedSections,
        conditions: advancedConditions
      };'''

new_design = r'''      const conditionedDesign = {
        ...enrichedDesign,
        ...(storedDesignForConditions ?? {}),
        sections: conditionedSections,
        conditions: advancedConditions
      };'''

if old_design not in source:
    raise SystemExit('Expected conditionedDesign block was not found')
source = source.replace(old_design, new_design, 1)

# Strengthen read-back verification. A condition is valid only when its controller
# resolves to a labelled Jira-linked persisted question, its advanced check points
# at that same question, and a non-empty constraint/output/section link survives.
old_verify = r'''          const cIds = raw?.i?.co?.cIds ?? {};
          const controllerIds = Object.keys(cIds);
          const targetIds = Array.isArray(raw?.o?.sIds) ? raw.o.sIds.map(String) : [];
          if (!controllerIds.length) brokenLinks.push(`${conditionId}: controller missing`);
          if (raw?.o?.t !== 'sh' && raw?.o?.t !== 'hide') brokenLinks.push(`${conditionId}: output type missing`);'''

new_verify = r'''          const cIds = raw?.i?.co?.cIds ?? {};
          const controllerIds = Object.keys(cIds);
          const groups = Array.isArray(raw?.i?.groups) ? raw.i.groups : [];
          const checks = groups.flatMap((group: any) => Array.isArray(group?.checks) ? group.checks : []);
          const persistedQuestions = verifyBody.design?.questions ?? {};
          const controllerQuestion = controllerIds.length ? persistedQuestions[controllerIds[0]] : undefined;
          const controllerHasIdentity = Boolean(
            controllerQuestion &&
            String(controllerQuestion?.label ?? '').trim() &&
            String(controllerQuestion?.jiraField ?? '').trim()
          );
          const hasMatchingAdvancedCheck = checks.some((check: any) =>
            controllerIds.includes(String(check?.fieldId ?? '')) &&
            String(check?.type ?? '') !== '' &&
            Array.isArray(check?.constraint) && check.constraint.length > 0 &&
            String(check.constraint[0] ?? '').trim() !== ''
          );
          const hasCompatibilityConstraint = controllerIds.some((id) =>
            Array.isArray(cIds[id]) && cIds[id].length > 0 && String(cIds[id][0] ?? '').trim() !== ''
          );
          const targetIds = Array.isArray(raw?.o?.sIds) ? raw.o.sIds.map(String) : [];
          if (!controllerIds.length) brokenLinks.push(`${conditionId}: compatibility controller missing`);
          if (!controllerHasIdentity) brokenLinks.push(`${conditionId}: controller does not resolve to a labelled Jira-linked Forms question`);
          if (!hasCompatibilityConstraint) brokenLinks.push(`${conditionId}: compatibility choice constraint missing`);
          if (!hasMatchingAdvancedCheck) brokenLinks.push(`${conditionId}: advanced field/operator/value check does not match persisted controller`);
          if (raw?.o?.t !== 'sh' && raw?.o?.t !== 'hide') brokenLinks.push(`${conditionId}: output type missing`);'''

if old_verify not in source:
    raise SystemExit('Expected Forms condition verification block was not found')
source = source.replace(old_verify, new_verify, 1)

path.write_text(source)
