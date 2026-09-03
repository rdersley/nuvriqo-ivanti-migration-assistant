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

new = r'''      // The pre-save question id is not safe for conditional logic. Jira Forms
      // can normalise/re-key linked questions when the template is stored. Resolve
      // the controller from the persisted design by the Jira field it is linked to.
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

      advancedConditions[conditionId] = {
        i: {
          // Keep Jira's compatibility map populated, but always reference the
          // persisted Forms question id rather than the pre-save synthetic id.
          co: {
            cIds: {
              [persistedControllerQuestionId]: [optionId]
            }
          },
          operator: 'OR',
          groups: [{
            operator: 'AND',
            checks: [{
              fieldId: persistedControllerQuestionId,
              type: 'SOME_OF',
              constraint: [optionId]
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

# Strengthen read-back verification: a condition only counts as verified when
# Jira persisted a controller that resolves to a real, labelled Forms question,
# as well as the operator/value check and target section linkage.
old_verify = r'''          const cIds = raw?.i?.co?.cIds ?? {};
          const controllerIds = Object.keys(cIds);
          const targetIds = Array.isArray(raw?.o?.sIds) ? raw.o.sIds.map(String) : [];
          if (!controllerIds.length) brokenLinks.push(`${conditionId}: controller missing`);
          if (raw?.o?.t !== 'sh' && raw?.o?.t !== 'hide') brokenLinks.push(`${conditionId}: output type missing`);'''

new_verify = r'''          const cIds = raw?.i?.co?.cIds ?? {};
          const controllerIds = Object.keys(cIds);
          const groups = Array.isArray(raw?.i?.groups) ? raw.i.groups : [];
          const checks = groups.flatMap((group: any) => Array.isArray(group?.checks) ? group.checks : []);
          const hasAdvancedCheck = checks.some((check: any) =>
            String(check?.fieldId ?? '') !== '' &&
            String(check?.type ?? '') !== '' &&
            Array.isArray(check?.constraint) && check.constraint.length > 0
          );
          const persistedQuestions = verifyBody.design?.questions ?? {};
          const controllerQuestion = controllerIds.length ? persistedQuestions[controllerIds[0]] : undefined;
          const controllerHasIdentity = Boolean(
            controllerQuestion &&
            String(controllerQuestion?.label ?? '').trim() &&
            String(controllerQuestion?.jiraField ?? '').trim()
          );
          const targetIds = Array.isArray(raw?.o?.sIds) ? raw.o.sIds.map(String) : [];
          if (!controllerIds.length) brokenLinks.push(`${conditionId}: compatibility controller missing`);
          if (!controllerHasIdentity) brokenLinks.push(`${conditionId}: controller does not resolve to a labelled Jira-linked Forms question`);
          if (!hasAdvancedCheck) brokenLinks.push(`${conditionId}: advanced field/operator/value check missing`);
          if (raw?.o?.t !== 'sh' && raw?.o?.t !== 'hide') brokenLinks.push(`${conditionId}: output type missing`);'''

if old_verify not in source:
    raise SystemExit('Expected Forms condition verification block was not found')
source = source.replace(old_verify, new_verify, 1)

path.write_text(source)
