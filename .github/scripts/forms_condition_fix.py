from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

# 1) Make JSM field resolution type-safe. Existing same-name fields are only
# reused for choice controllers when they are genuine Jira single-select fields.
old_resolver = r'''async function resolveJsmFields(fields: JsmFieldInput[]) {
  const resolution = await resolveScreenFields(fields.map((field) => ({ id: field.id, name: field.name })));
  const byName = new Map(resolution.resolved.map((field) => [normaliseStatusName(field.name), field.id]));
  return fields.map((field) => ({ ...field, jiraFieldId: field.id || byName.get(normaliseStatusName(field.name)) })).filter((field) => field.jiraFieldId);
}'''

new_resolver = r'''async function resolveJsmFields(fields: JsmFieldInput[]) {
  const resolution = await resolveScreenFields(fields.map((field) => ({ id: field.id, name: field.name })));
  const byName = new Map(resolution.resolved.map((field) => [normaliseStatusName(field.name), field.id]));

  const catalogueResponse = await api.asUser().requestJira(route`/rest/api/3/field`, {
    headers: { Accept: 'application/json' }
  });
  const catalogue = await parseResponse<JiraField[]>(catalogueResponse);
  const byId = new Map(catalogue.map((field) => [String(field.id), field]));
  const output: Array<JsmFieldInput & { jiraFieldId: string; repairedChoiceField?: boolean }> = [];

  for (const field of fields) {
    let jiraFieldId = String(field.id || byName.get(normaliseStatusName(field.name)) || '');
    if (!jiraFieldId) continue;

    const needsChoice = ['select', 'checkbox'].includes(String(field.jiraType ?? '').toLowerCase());
    const actual = byId.get(jiraFieldId);
    const actualCustomType = String(actual?.schema?.custom ?? '');
    const choiceCompatible = actualCustomType.includes('customfieldtypes:select');

    if (needsChoice && !choiceCompatible) {
      const repairName = `${field.name} - Ivanti Choice`;
      let repair = catalogue.find((item) =>
        normaliseStatusName(item.name) === normaliseStatusName(repairName) &&
        String(item.schema?.custom ?? '').includes('customfieldtypes:select')
      );

      if (!repair) {
        const createResponse = await api.asUser().requestJira(route`/rest/api/3/field`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: repairName,
            description: `Type-safe Jira choice field created for migrated Ivanti field ${field.name}.`,
            type: FIELD_TYPES.select.type,
            searcherKey: FIELD_TYPES.select.searcherKey
          })
        });
        repair = await parseResponse<JiraField>(createResponse);
        catalogue.push(repair);
        byId.set(String(repair.id), repair);
      }

      const requestedOptions = [...new Set(
        ((field.options?.length ? field.options : String(field.jiraType).toLowerCase() === 'checkbox' ? ['Yes', 'No'] : []) as string[])
          .map((value) => String(value).trim())
          .filter(Boolean)
      )];
      if (requestedOptions.length) await addMissingOptions(String(repair.id), requestedOptions);
      jiraFieldId = String(repair.id);
      output.push({ ...field, jiraFieldId, repairedChoiceField: true });
      continue;
    }

    output.push({ ...field, jiraFieldId });
  }

  return output;
}'''

if old_resolver in source:
    source = source.replace(old_resolver, new_resolver, 1)

# 2) Keep the complete Jira read-back design for native Forms condition wiring.
old_readback_start = """  // Read the template back from Jira and verify the actual stored layout, instead\n  // of trusting a successful PUT response.\n  let designVerified = false;"""
new_readback_start = """  // Read the template back from Jira and verify the actual stored layout, instead\n  // of trusting a successful PUT response. Keep the stored design because native\n  // Forms conditions must reference the exact persisted question/section ids.\n  let designVerified = false;\n  let storedDesignForConditions: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> } | undefined;"""
if old_readback_start in source:
    source = source.replace(old_readback_start, new_readback_start, 1)

old_stored = """    const stored = await parseResponse<{\n      design?: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> }\n    }>(getResponse);\n    const storedQuestions"""
new_stored = """    const stored = await parseResponse<{\n      design?: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> }\n    }>(getResponse);\n    storedDesignForConditions = stored.design;\n    const storedQuestions"""
if old_stored in source:
    source = source.replace(old_stored, new_stored, 1)

# 3) Replace every experimental/advanced condition builder with Jira Forms' own
# native runtime representation. A real Jira-created form stores:
#   conditions[id].i.co.cIds[questionId] = [choiceOptionId]
#   conditions[id].o.sIds = [sectionId]
#   conditions[id].t = 'sh'
# and the target section itself references conditions:[id].
start_marker = "      // Atlassian Forms does not allow EQUAL_TO for ChoiceDropDown"
if start_marker not in source:
    # Previous patch revisions may have a different comment, anchor on controllerField.
    start_marker = "      const controllerField = fields.find("
start = source.index(start_marker)
end_marker = "\n    if (Object.keys(advancedConditions).length)"
end = source.index(end_marker, start)

replacement = r'''      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerResolved = resolved.find((item) =>
        String(item.sourceId ?? '') === String(condition.controllerFieldId) ||
        normaliseStatusName(item.name) === normaliseStatusName(controllerField?.name)
      );
      const conditionId = String(conditionIndex + 1);
      const desiredValue = String(condition.value ?? '').trim();
      const controllerFormType = formQuestionType(controllerField?.jiraType);

      if (controllerFormType !== 'cd') {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `Controller ${controllerField?.name || condition.controllerFieldId} is not a choice question; native section logic currently requires a choice controller.`
        });
        continue;
      }

      const jiraFieldId = String(controllerResolved?.jiraFieldId ?? '');
      if (!jiraFieldId) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: 'Controller Jira choice field was not resolved.'
        });
        continue;
      }

      // Native Forms conditional logic for linked Jira dropdowns references the
      // Jira option ID, not the display label. Resolve it from the repaired or
      // existing single-select field.
      let optionId = '';
      try {
        const contextId = await getFirstContextId(jiraFieldId);
        const optionResponse = await api.asUser().requestJira(
          route`/rest/api/3/field/${jiraFieldId}/context/${contextId}/option?maxResults=1000`,
          { headers: { Accept: 'application/json' } }
        );
        const optionBody = await parseResponse<{ values?: Array<{ id?: string; value?: string }> }>(optionResponse);
        const wanted = normaliseStatusName(desiredValue);
        const option = (optionBody.values ?? []).find((item) => normaliseStatusName(item.value) === wanted);
        optionId = String(option?.id ?? '');
      } catch (error) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `Could not resolve native Jira option id for ${controllerField?.name || jiraFieldId}: ${error instanceof Error ? error.message : String(error)}`
        });
        continue;
      }

      if (!optionId) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: `No Jira option matched Ivanti value '${desiredValue}' for ${controllerField?.name || jiraFieldId}.`
        });
        continue;
      }

      const storedSectionKeys = Object.keys(storedDesignForConditions?.sections ?? {});
      const resolvedTargetSectionIds = targetSectionIds
        .map((candidate) => {
          if (storedSectionKeys.includes(candidate)) return candidate;
          const numeric = Number(candidate);
          if (Number.isFinite(numeric) && numeric > 0) return storedSectionKeys[numeric - 1];
          return undefined;
        })
        .filter((value): value is string => Boolean(value));

      if (!resolvedTargetSectionIds.length) {
        unresolvedRules.push({
          id: String((condition as any).id ?? conditionIndex + 1),
          reason: 'Jira read-back did not contain the target conditional section.'
        });
        continue;
      }

      // This is the exact native legacy/runtime shape emitted by Jira Forms.
      advancedConditions[conditionId] = {
        i: {
          co: {
            cIds: {
              [controllerQuestionId]: [optionId]
            }
          }
        },
        o: {
          sIds: resolvedTargetSectionIds
        },
        t: 'sh'
      };
    }
'''
source = source[:start] + replacement + source[end:]

# 4) Save all accepted conditions together and wire each target section back to
# its condition id. Jira's own saved forms contain BOTH sides of this relation.
save_start = source.index("    if (Object.keys(advancedConditions).length) {", start)
save_end = source.index("  } else {\n    stages.push({ key: 'conditions'", save_start)

save_replacement = r'''    if (Object.keys(advancedConditions).length) {
      const conditionedSections: Record<string, unknown> = {};
      const baseStoredSections = storedDesignForConditions?.sections ?? formSections;

      for (const [sectionId, sectionValue] of Object.entries(baseStoredSections)) {
        const sectionRecord = { ...(sectionValue as Record<string, unknown>) };
        const refs: string[] = [];
        for (const [conditionId, rawCondition] of Object.entries(advancedConditions)) {
          const output = (rawCondition as any)?.o;
          const sIds = Array.isArray(output?.sIds) ? output.sIds.map(String) : [];
          if (sIds.includes(String(sectionId))) refs.push(String(conditionId));
        }
        sectionRecord.conditions = refs;
        conditionedSections[String(sectionId)] = sectionRecord;
      }

      const conditionedDesign = {
        ...enrichedDesign,
        sections: conditionedSections,
        conditions: advancedConditions
      };

      try {
        const conditionResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
          method: 'PUT',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
          body: JSON.stringify({ design: conditionedDesign })
        });
        await parseResponse(conditionResponse);

        const verifyResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
          headers: { Accept: 'application/json' }
        });
        const verifyBody = await parseResponse<{
          design?: { conditions?: Record<string, any>; sections?: Record<string, any>; questions?: Record<string, any> }
        }>(verifyResponse);

        const persistedConditions = verifyBody.design?.conditions ?? {};
        const persistedSections = verifyBody.design?.sections ?? {};
        const expectedIds = Object.keys(advancedConditions);
        const missingConditions = expectedIds.filter((id) => !persistedConditions[id]);
        const brokenSectionRefs: string[] = [];

        for (const conditionId of expectedIds) {
          const raw = persistedConditions[conditionId];
          const cIds = raw?.i?.co?.cIds ?? {};
          const controllerIds = Object.keys(cIds);
          const targetIds = Array.isArray(raw?.o?.sIds) ? raw.o.sIds.map(String) : [];
          if (!controllerIds.length) brokenSectionRefs.push(`${conditionId}: controller missing`);
          for (const sectionId of targetIds) {
            const refs = Array.isArray(persistedSections?.[sectionId]?.conditions)
              ? persistedSections[sectionId].conditions.map(String)
              : [];
            if (!refs.includes(conditionId)) brokenSectionRefs.push(`${conditionId}: section ${sectionId} not linked`);
          }
        }

        conditionSaveSucceeded = missingConditions.length === 0 && brokenSectionRefs.length === 0 && unresolvedRules.length === 0;
        activeDesign = conditionedDesign;
        if (missingConditions.length || brokenSectionRefs.length) {
          unresolvedRules.push({
            reason: `Native Forms read-back verification failed. Missing conditions: ${missingConditions.join(', ') || 'none'}; broken links: ${brokenSectionRefs.join(', ') || 'none'}.`
          });
        }

        stages.push({
          key: 'conditions',
          status: conditionSaveSucceeded ? 'verified' : 'partial',
          message: conditionSaveSucceeded
            ? `Saved and read back ${expectedIds.length}/${conditions.length} Ivanti rule(s) in Jira Forms native runtime format, including controller option IDs and section condition links. Portal No/Yes behaviour still requires functional confirmation.`
            : `Native Forms condition wiring is incomplete: ${unresolvedRules[0]?.reason || 'read-back verification failed.'}`,
          detail: unresolvedRules.length ? { unresolvedRules } : undefined
        });
      } catch (error) {
        const detail = apiErrorDetail(error);
        unresolvedRules.push({ reason: `Atlassian rejected native Forms condition wiring: ${JSON.stringify(detail)}` });
        stages.push({
          key: 'conditions',
          status: 'partial',
          message: `Native Forms condition wiring failed: ${unresolvedRules[0]?.reason}`,
          detail: { unresolvedRules }
        });
      }
    } else {
      stages.push({
        key: 'conditions',
        status: 'partial',
        message: `None of the ${conditions.length} inferred Ivanti conditional rule(s) could be mapped to Jira's native Forms condition model.`,
        detail: { unresolvedRules }
      });
    }
'''
source = source[:save_start] + save_replacement + source[save_end:]

path.write_text(source)
