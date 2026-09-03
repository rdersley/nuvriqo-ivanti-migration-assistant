from pathlib import Path

path = Path('src/index.ts')
source = path.read_text()

old = """      const persistedControllerQuestionId = String(persistedControllerEntry?.[0] ?? '');
      const persistedControllerQuestion = persistedControllerEntry?.[1] as Record<string, unknown> | undefined;

      if (!persistedControllerQuestionId || !persistedControllerQuestion) {"""
new = """      const persistedControllerQuestionKey = String(persistedControllerEntry?.[0] ?? '');
      const persistedControllerQuestion = persistedControllerEntry?.[1] as Record<string, unknown> | undefined;
      // Some Forms responses key the questions map by an internal map key while
      // the condition engine expects the question's canonical id. Prefer the
      // canonical id returned on the persisted question object, falling back to
      // the map key only when Jira does not expose one.
      const persistedControllerQuestionId = String(
        persistedControllerQuestion?.id ?? persistedControllerQuestionKey ?? ''
      );

      if (!persistedControllerQuestionId || !persistedControllerQuestion) {"""
if old not in source:
    raise SystemExit('Persisted controller id block not found')
source = source.replace(old, new, 1)

old_verify = """          const persistedQuestions = verifyBody.design?.questions ?? {};
          const controllerQuestion = controllerIds.length ? persistedQuestions[controllerIds[0]] : undefined;
          const controllerHasIdentity = Boolean(
            controllerQuestion &&
            String(controllerQuestion?.label ?? '').trim() &&
            String(controllerQuestion?.jiraField ?? '').trim()
          );"""
new_verify = """          const persistedQuestions = verifyBody.design?.questions ?? {};
          const controllerQuestion = controllerIds.length
            ? (persistedQuestions[controllerIds[0]] ?? Object.values(persistedQuestions).find((question: any) =>
                String(question?.id ?? '') === String(controllerIds[0])
              ))
            : undefined;
          const controllerHasIdentity = Boolean(
            controllerQuestion &&
            String(controllerQuestion?.label ?? '').trim() &&
            String(controllerQuestion?.jiraField ?? '').trim()
          );"""
if old_verify not in source:
    raise SystemExit('Controller verification block not found')
source = source.replace(old_verify, new_verify, 1)

# Make an unresolved/unnamed controller a hard condition failure and expose
# enough identity detail to diagnose Jira's persisted representation immediately.
old_message = """          message: conditionSaveSucceeded
            ? `Saved and read back ${expectedIds.length}/${conditions.length} Ivanti rule(s) with native controller option IDs, output types and section condition links. Portal No/Yes behaviour still requires functional confirmation.`
            : `Native Forms condition wiring is incomplete: ${unresolvedRules[0]?.reason || 'read-back verification failed.'}`,"""
new_message = """          message: conditionSaveSucceeded
            ? `Saved and read back ${expectedIds.length}/${conditions.length} Ivanti rule(s) with canonical persisted Forms controller IDs, values, outputs and section links. Portal No/Yes behaviour still requires functional confirmation.`
            : `Native Forms condition wiring is incomplete: ${unresolvedRules[0]?.reason || 'read-back verification failed.'}`,"""
if old_message in source:
    source = source.replace(old_message, new_message, 1)

path.write_text(source)
