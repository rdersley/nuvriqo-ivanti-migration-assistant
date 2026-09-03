from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

start = source.index('      // Atlassian Forms does not allow EQUAL_TO for ChoiceDropDown')
end_marker = "\n    if (Object.keys(advancedConditions).length)"
end = source.index(end_marker, start)

replacement = r'''      // Build conditional visibility as an explicit HIDE rule when the
      // controlling answer does not match the Ivanti source condition. In the
      // portal this gives the required behaviour: dependent sections stay
      // hidden for blank/non-matching answers and become visible only when the
      // source condition is satisfied.
      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerFormType = formQuestionType(controllerField?.jiraType);
      const conditionId = String(conditionIndex + 1);
      const comparisonType = controllerFormType === 'cd' ? 'NONE_OF' : 'DOES_NOT_EQUAL';
      const comparisonConstraint = [String(condition.value ?? '')];

      advancedConditions[conditionId] = {
        i: {
          co: {
            cIds: {}
          },
          operator: 'OR',
          groups: [{
            operator: 'AND',
            checks: [{
              fieldId: controllerQuestionId,
              type: comparisonType,
              constraint: comparisonConstraint
            }]
          }]
        },
        o: {
          sIds: targetSectionIds,
          t: 'hide'
        }
      };
    }
'''

source = source[:start] + replacement + source[end:]

# Save each inferred condition independently so one unsupported source rule
# cannot remove the other valid conditions, and surface the exact Atlassian
# validation response for the individual failing rule.
save_start = source.index("    if (Object.keys(advancedConditions).length) {", start)
save_end = source.index("  } else {\n    stages.push({ key: 'conditions'", save_start)

save_replacement = r'''    if (Object.keys(advancedConditions).length) {
      const acceptedConditions: Record<string, unknown> = {};

      for (const [candidateId, candidateCondition] of Object.entries(advancedConditions)) {
        const candidateConditions = {
          ...acceptedConditions,
          [candidateId]: candidateCondition
        };
        const candidateDesign = {
          ...enrichedDesign,
          conditions: candidateConditions
        };

        try {
          const conditionResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
            method: 'PUT',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
            body: JSON.stringify({ design: candidateDesign })
          });
          await parseResponse(conditionResponse);
          acceptedConditions[candidateId] = candidateCondition;
          activeDesign = candidateDesign;
        } catch (error) {
          const detail = apiErrorDetail(error);
          let detailText = '';
          try { detailText = JSON.stringify(detail); } catch { detailText = String(detail); }
          unresolvedRules.push({
            id: candidateId,
            reason: `Atlassian rejected this rule: ${detailText}`
          });
        }
      }

      const acceptedCount = Object.keys(acceptedConditions).length;
      conditionSaveSucceeded = acceptedCount === conditions.length && unresolvedRules.length === 0;
      const firstFailure = unresolvedRules[0]?.reason;
      stages.push({
        key: 'conditions',
        status: conditionSaveSucceeded ? 'verified' : 'partial',
        message:
          `Applied ${acceptedCount}/${conditions.length} inferred Ivanti conditional rule(s) as explicit hide-on-non-match rules.` +
          (firstFailure ? ` First unresolved rule: ${firstFailure}` : ''),
        detail: unresolvedRules.length ? { unresolvedRules, acceptedConditionIds: Object.keys(acceptedConditions) } : undefined
      });
    } else {
      stages.push({
        key: 'conditions',
        status: 'partial',
        message: `None of the ${conditions.length} inferred Ivanti conditional rule(s) could be safely mapped to a Form section.`,
        detail: { unresolvedRules }
      });
    }
'''

source = source[:save_start] + save_replacement + source[save_end:]

path.write_text(source)
