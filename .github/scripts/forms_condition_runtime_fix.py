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

new = r'''      advancedConditions[conditionId] = {
        i: {
          // Keep Jira's compatibility map populated, but also provide the
          // documented advanced condition model. The Forms editor and portal
          // runtime resolve the visible controller/operator/value from the
          // groups/checks structure.
          co: {
            cIds: {
              [controllerQuestionId]: [optionId]
            }
          },
          operator: 'OR',
          groups: [{
            operator: 'AND',
            checks: [{
              fieldId: controllerQuestionId,
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
# Jira persisted the advanced controller/operator/value check as well as the
# target section linkage.
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
          const targetIds = Array.isArray(raw?.o?.sIds) ? raw.o.sIds.map(String) : [];
          if (!controllerIds.length) brokenLinks.push(`${conditionId}: compatibility controller missing`);
          if (!hasAdvancedCheck) brokenLinks.push(`${conditionId}: advanced field/operator/value check missing`);
          if (raw?.o?.t !== 'sh' && raw?.o?.t !== 'hide') brokenLinks.push(`${conditionId}: output type missing`);'''

if old_verify not in source:
    raise SystemExit('Expected Forms condition verification block was not found')
source = source.replace(old_verify, new_verify, 1)

path.write_text(source)
