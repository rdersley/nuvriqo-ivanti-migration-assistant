from pathlib import Path

# Keep this as a build-time patch because the current deployment pipeline already
# applies the Forms migration hardening patches before typecheck/build.
parser = Path('static/src/xmlParser.ts')
text = parser.read_text()

text = text.replace("  'hiring manager': 'user',\n  'department manager': 'user',", "  // Ivanti manager controls are dynamic Ivanti business-object lookups, not\n  // necessarily Jira users/customers. A Jira user picker makes the migrated\n  // request impossible to complete for names that do not have Jira accounts.\n  // Preserve them as free text unless a future lookup-data migration can supply\n  // a real Jira-backed option set.\n  'hiring manager': 'text',\n  'department manager': 'text',")

old_raw = """function rawType(node: Element): string {\n  return (\n    attributeOf(node, ['type', 'Type', 'dataType', 'DataType', 'controlType', 'ControlType']) ||\n    textOf(node, [\n      ':scope > Type', ':scope > type', ':scope > DataType',\n      ':scope > dataType', ':scope > ControlType', ':scope > controlType'\n    ])\n  ).trim();\n}\n"""
new_raw = """function rawType(node: Element): string {\n  return (\n    attributeOf(node, ['type', 'Type', 'dataType', 'DataType', 'controlType', 'ControlType', 'displayType', 'DisplayType']) ||\n    textOf(node, [\n      ':scope > Type', ':scope > type', ':scope > DataType',\n      ':scope > dataType', ':scope > ControlType', ':scope > controlType',\n      ':scope > DisplayType', ':scope > displayType'\n    ])\n  ).trim();\n}\n\nfunction isCustomerVisibleField(node: Element): boolean {\n  const visibility = textOf(node, [':scope > VisibilityExpression', ':scope > visibilityExpression']).replace(/\\s+/g, '').toLowerCase();\n  // Ivanti exports internal/calculated helper parameters as ordinary parameter\n  // elements too. $(false) is an explicit instruction that the requester never\n  // sees the field, so do not leak it onto the Jira portal form.\n  return visibility not in ('$(false)', 'false', '0')\n}\n""".replace("return visibility not in ('$(false)', 'false', '0')", "return !['$(false)', 'false', '0'].includes(visibility);")
if old_raw not in text:
    raise SystemExit('rawType anchor not found')
text = text.replace(old_raw, new_raw)

old_loop = "for (const node of [...document.querySelectorAll('*')].filter(looksLikeField)) {\n    const name = fieldName(node);"
new_loop = "for (const node of [...document.querySelectorAll('*')].filter(looksLikeField)) {\n    if (!isCustomerVisibleField(node)) continue;\n    const name = fieldName(node);"
if old_loop not in text:
    raise SystemExit('field loop anchor not found')
text = text.replace(old_loop, new_loop)
parser.write_text(text)

backend = Path('src/index.ts')
text = backend.read_text()
anchor = """function normaliseOptions(field: FieldRequest): string[] {\n"""
helper = """function fieldMatchesRequestedType(existing: JiraField, jiraType: FieldRequest['jiraType']): boolean {\n  const expected = FIELD_TYPES[jiraType] ?? FIELD_TYPES.text;\n  return String(existing.schema?.custom || '') === expected.type;\n}\n\n"""
if helper not in text:
    if anchor not in text:
        raise SystemExit('normaliseOptions anchor not found')
    text = text.replace(anchor, helper + anchor)

old_dup = """    const duplicate = existingByName.get(name.toLowerCase());\n    if (duplicate) {\n      results.push({\n        name,\n        ivantiName: field.ivantiName,\n        status: 'reused',\n        id: duplicate.id,\n        message: 'An exact-name Jira field already exists; no changes were made to it.',\n        steps: [{ step: 'field', status: 'reused', message: `Reused ${duplicate.id}.` }]\n      });\n      continue;\n    }\n"""
new_dup = """    const duplicate = existingByName.get(name.toLowerCase());\n    if (duplicate && fieldMatchesRequestedType(duplicate, field.jiraType)) {\n      results.push({\n        name,\n        ivantiName: field.ivantiName,\n        status: 'reused',\n        id: duplicate.id,\n        message: 'An exact-name Jira field with the correct type already exists; no changes were made to it.',\n        steps: [{ step: 'field', status: 'reused', message: `Reused ${duplicate.id}.` }]\n      });\n      continue;\n    }\n    // Jira custom-field types cannot be changed in place. If an earlier migration\n    // created the same Ivanti field with the wrong type (for example a dynamic\n    // Ivanti employee lookup as a Jira user picker), deliberately create a new\n    // same-label field of the correct type. The returned field ID is then used by\n    // the Forms migration, while the obsolete field can be cleaned up later.\n"""
if old_dup not in text:
    raise SystemExit('duplicate anchor not found')
text = text.replace(old_dup, new_dup)
backend.write_text(text)

print('Applied Ivanti lookup/helper-field fidelity fix')
