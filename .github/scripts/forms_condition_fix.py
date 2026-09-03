from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

# Keep the normal Forms section schema. Advanced conditions target sections
# through design.conditions.*.o.sIds; section definitions themselves do not
# need a custom conditions property.

start = source.index('      // Atlassian Forms does not allow EQUAL_TO for ChoiceDropDown')
end_marker = "\n    if (Object.keys(advancedConditions).length)"
end = source.index(end_marker, start)

replacement = r'''      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerFormType = formQuestionType(controllerField?.jiraType);
      const conditionId = String(conditionIndex + 1);
      let comparisonType = 'EQUAL_TO';
      let comparisonConstraint = [String(condition.value ?? '')];

      if (controllerFormType === 'cd') {
        const controllerResolved = resolved.find((item) =>
          normaliseStatusName(item.name) === normaliseStatusName(controllerField?.name)
        );
        const jiraFieldId = String(controllerResolved?.jiraFieldId ?? '');
        if (!jiraFieldId) {
          unresolvedRules.push({
            id: String((condition as any).id ?? conditionIndex + 1),
            reason: 'Controller Jira choice field was not resolved.'
          });
          continue;
        }

        try {
          const contextId = await getFirstContextId(jiraFieldId);
          const optionResponse = await api.asUser().requestJira(
            route`/rest/api/3/field/${jiraFieldId}/context/${contextId}/option?maxResults=100`,
            { headers: { Accept: 'application/json' } }
          );
          const optionBody = await parseResponse<{ values?: Array<{ id?: string; value?: string }> }>(optionResponse);
          const wanted = normaliseStatusName(condition.value);
          const option = (optionBody.values ?? []).find((item) =>
            normaliseStatusName(item.value) === wanted
          );
          if (option?.id) {
            comparisonType = 'SOME_OF';
            comparisonConstraint = [String(option.id)];
          } else {
            // Some Forms-backed choice questions do not expose Jira context
            // options. In that case use the visible value directly rather than
            // discarding an otherwise valid Ivanti condition.
            comparisonType = 'EQUAL_TO';
            comparisonConstraint = [String(condition.value ?? '')];
          }
        } catch (error) {
          // Jira returns 400 "custom field doesn't support options" for some
          // linked Forms choice questions. Treat those as value-backed choices
          // and let the Forms condition API validate the visible source value.
          const message = String((error as Error)?.message ?? error);
          if (message.includes("doesn't support options") || message.includes('does not support options') || message.includes('400')) {
            comparisonType = 'EQUAL_TO';
            comparisonConstraint = [String(condition.value ?? '')];
          } else {
            unresolvedRules.push({
              id: String((condition as any).id ?? conditionIndex + 1),
              reason: `Could not resolve Jira option ID: ${message}`
            });
            continue;
          }
        }
      }

      advancedConditions[conditionId] = {
        i: {
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
          t: 'sh'
        }
      };
    }
'''

source = source[:start] + replacement + source[end:]

# Save each inferred condition independently. One unsupported Ivanti rule must
# not cause Jira to reject every other valid rule. This also surfaces the exact
# Atlassian validation response for the individual failing rule.
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
          `Applied ${acceptedCount}/${conditions.length} inferred Ivanti conditional rule(s) independently using the documented Forms advanced-condition schema.` +
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
