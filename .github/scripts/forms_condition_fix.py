from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

old_section = """      formSections[String(sectionIndex)] = {
        name: section.name || `Section ${sectionIndex + 1}`,
        sectionType: 'p'
      };"""
new_section = """      formSections[String(sectionIndex)] = {
        name: section.name || `Section ${sectionIndex + 1}`,
        sectionType: 'p',
        conditions: [] as string[]
      };"""
if old_section not in source:
    raise SystemExit('Expected form section block not found')
source = source.replace(old_section, new_section, 1)

start = source.index('      // Atlassian Forms does not allow EQUAL_TO for ChoiceDropDown')
end_marker = "\n    if (Object.keys(advancedConditions).length)"
end = source.index(end_marker, start)

replacement = r'''      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerFormType = formQuestionType(controllerField?.jiraType);
      const conditionId = String(conditionIndex + 1);

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
          if (!option?.id) {
            unresolvedRules.push({
              id: String((condition as any).id ?? conditionIndex + 1),
              reason: `No Jira option ID matched condition value ${String(condition.value ?? '')}.`
            });
            continue;
          }

          advancedConditions[conditionId] = {
            i: {
              co: {
                cIds: {
                  [controllerQuestionId]: [String(option.id)]
                }
              }
            },
            o: {
              sIds: targetSectionIds,
              t: 'sh'
            }
          };
        } catch (error) {
          unresolvedRules.push({
            id: String((condition as any).id ?? conditionIndex + 1),
            reason: `Could not resolve Jira option ID: ${String((error as Error)?.message ?? error)}`
          });
          continue;
        }
      } else {
        advancedConditions[conditionId] = {
          i: {
            operator: 'OR',
            groups: [{
              operator: 'AND',
              checks: [{
                fieldId: controllerQuestionId,
                type: 'EQUAL_TO',
                constraint: [String(condition.value ?? '')]
              }]
            }]
          },
          o: {
            sIds: targetSectionIds,
            t: 'sh'
          }
        };
      }

      for (const sectionId of targetSectionIds) {
        const sectionDefinition = formSections[sectionId] as { conditions?: string[] } | undefined;
        if (!sectionDefinition) continue;
        if (!Array.isArray(sectionDefinition.conditions)) sectionDefinition.conditions = [];
        if (!sectionDefinition.conditions.includes(conditionId)) {
          sectionDefinition.conditions.push(conditionId);
        }
      }
    }
'''

source = source[:start] + replacement + source[end:]

needle = "body: JSON.stringify({ design: conditionedDesign })"
put_at = source.index(needle)
header_start = source.rfind("headers: { Accept: 'application/json', 'Content-Type': 'application/json' },", 0, put_at)
if header_start >= 0:
    old_header = "headers: { Accept: 'application/json', 'Content-Type': 'application/json' },"
    new_header = "headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },"
    source = source[:header_start] + source[header_start:].replace(old_header, new_header, 1)

path.write_text(source)
