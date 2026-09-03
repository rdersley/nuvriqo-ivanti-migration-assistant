from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

# 1) Make JSM field resolution type-safe. The old resolver trusted an exact-name
# duplicate even when its Jira custom-field type was incompatible with the
# Ivanti source field. That can produce a Forms ChoiceDropDown backed by a Jira
# field that has no option semantics. Repair only choice controllers by creating
# a dedicated single-select migration field when necessary.
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

if old_resolver not in source:
    raise SystemExit('Expected resolveJsmFields block not found')
source = source.replace(old_resolver, new_resolver, 1)

# 2) Keep the complete Jira read-back design. Conditions must be built from the
# question/section representation Jira actually stored, not only from our input.
old_readback_start = """  // Read the template back from Jira and verify the actual stored layout, instead\n  // of trusting a successful PUT response.\n  let designVerified = false;"""
new_readback_start = """  // Read the template back from Jira and verify the actual stored layout, instead\n  // of trusting a successful PUT response. Keep the stored design because Forms\n  // may normalise linked choice questions and section identifiers.\n  let designVerified = false;\n  let storedDesignForConditions: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> } | undefined;"""
if old_readback_start not in source:
    raise SystemExit('Expected readback marker not found')
source = source.replace(old_readback_start, new_readback_start, 1)

old_stored = """    const stored = await parseResponse<{\n      design?: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> }\n    }>(getResponse);\n    const storedQuestions"""
new_stored = """    const stored = await parseResponse<{\n      design?: { questions?: Record<string, unknown>; layout?: unknown[]; sections?: Record<string, unknown> }\n    }>(getResponse);\n    storedDesignForConditions = stored.design;\n    const storedQuestions"""
if old_stored not in source:
    raise SystemExit('Expected stored form readback block not found')
source = source.replace(old_stored, new_stored, 1)

# 3) Replace the condition builder. Use the stored Forms question to resolve the
# actual choice token when Jira exposes one. Also resolve target section IDs from
# the stored section map by name/order rather than assuming our array index is
# always the final Forms section ID.
start = source.index('      // Atlassian Forms does not allow EQUAL_TO for ChoiceDropDown')
end_marker = "\n    if (Object.keys(advancedConditions).length)"
end = source.index(end_marker, start)

replacement = r'''      const controllerField = fields.find(
        (field) => String(field.sourceId ?? '') === String(condition.controllerFieldId)
      );
      const controllerFormType = formQuestionType(controllerField?.jiraType);
      const conditionId = String(conditionIndex + 1);
      const desiredValue = String(condition.value ?? '');

      // Jira can normalise linked choice questions during form save. Search the
      // stored question object recursively for a label/value that matches the
      // Ivanti condition and use its associated id/key/value token when present.
      const storedQuestion = storedDesignForConditions?.questions?.[controllerQuestionId] as unknown;
      const wanted = normaliseStatusName(desiredValue);
      const seen = new Set<unknown>();
      const findChoiceToken = (node: unknown): string | undefined => {
        if (!node || typeof node !== 'object' || seen.has(node)) return undefined;
        seen.add(node);
        if (Array.isArray(node)) {
          for (const item of node) {
            const found = findChoiceToken(item);
            if (found) return found;
          }
          return undefined;
        }
        const record = node as Record<string, unknown>;
        const labels = [record.label, record.name, record.text, record.displayName, record.value]
          .map((value) => value == null ? '' : String(value));
        if (labels.some((value) => normaliseStatusName(value) === wanted)) {
          for (const key of ['id', 'key', 'choiceId', 'optionId', 'value']) {
            const token = record[key];
            if (token !== undefined && token !== null && String(token).trim()) return String(token);
          }
        }
        for (const value of Object.values(record)) {
          const found = findChoiceToken(value);
          if (found) return found;
        }
        return undefined;
      };

      const storedChoiceToken = controllerFormType === 'cd' ? findChoiceToken(storedQuestion) : undefined;
      const comparisonType = controllerFormType === 'cd' ? 'SOME_OF' : 'EQUAL_TO';
      const comparisonConstraint = [storedChoiceToken || desiredValue];

      // Re-resolve target section IDs against Jira's stored section keys. The
      // prepared sections array and Forms' section map are order-compatible, but
      // using the stored keys avoids silently targeting a non-rendered section.
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

      advancedConditions[conditionId] = {
        i: {
          // Keep the compatibility object because Jira currently validates its
          // presence, but do not invent a second condition model inside it.
          co: { cIds: {} },
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
          sIds: resolvedTargetSectionIds,
          t: 'sh'
        }
      };
    }
'''
source = source[:start] + replacement + source[end:]

# 4) Keep independent saves, but verify the exact saved rule contents after each
# PUT rather than treating a 2xx response as runtime-ready.
save_start = source.index("    if (Object.keys(advancedConditions).length) {", start)
save_end = source.index("  } else {\n    stages.push({ key: 'conditions'", save_start)

save_replacement = r'''    if (Object.keys(advancedConditions).length) {
      const acceptedConditions: Record<string, unknown> = {};

      for (const [candidateId, candidateCondition] of Object.entries(advancedConditions)) {
        const candidateConditions = { ...acceptedConditions, [candidateId]: candidateCondition };
        const candidateDesign = { ...enrichedDesign, conditions: candidateConditions };

        try {
          const conditionResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
            method: 'PUT',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-ExperimentalApi': 'opt-in' },
            body: JSON.stringify({ design: candidateDesign })
          });
          await parseResponse(conditionResponse);

          const verifyResponse = await api.asUser().requestJira(route`/forms/project/${projectId}/form/${formId}`, {
            headers: { Accept: 'application/json' }
          });
          const verifyBody = await parseResponse<{ design?: { conditions?: Record<string, unknown> } }>(verifyResponse);
          const persisted = verifyBody.design?.conditions?.[candidateId];
          if (!persisted) throw new Error(`Jira did not persist condition ${candidateId} on read-back.`);

          acceptedConditions[candidateId] = persisted;
          activeDesign = { ...enrichedDesign, conditions: { ...acceptedConditions } };
        } catch (error) {
          const detail = apiErrorDetail(error);
          let detailText = '';
          try { detailText = JSON.stringify(detail); } catch { detailText = String(detail); }
          unresolvedRules.push({ id: candidateId, reason: `Condition ${candidateId} failed save/read-back verification: ${detailText}` });
        }
      }

      const acceptedCount = Object.keys(acceptedConditions).length;
      conditionSaveSucceeded = acceptedCount === conditions.length && unresolvedRules.length === 0;
      const firstFailure = unresolvedRules[0]?.reason;
      stages.push({
        key: 'conditions',
        status: conditionSaveSucceeded ? 'verified' : 'partial',
        message:
          `Saved and read back ${acceptedCount}/${conditions.length} inferred Ivanti conditional rule(s) using Jira-normalised question and section metadata.` +
          (firstFailure ? ` First unresolved rule: ${firstFailure}` : '') +
          (conditionSaveSucceeded ? ' Portal behaviour still requires the functional No/Yes test before migration sign-off.' : ''),
        detail: unresolvedRules.length ? { unresolvedRules, acceptedConditionIds: Object.keys(acceptedConditions) } : undefined
      });
    } else {
      stages.push({
        key: 'conditions',
        status: 'partial',
        message: `None of the ${conditions.length} inferred Ivanti conditional rule(s) could be safely mapped to a stored Form section.`,
        detail: { unresolvedRules }
      });
    }
'''
source = source[:save_start] + save_replacement + source[save_end:]

path.write_text(source)
