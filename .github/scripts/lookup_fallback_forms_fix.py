from pathlib import Path

# Preserve Ivanti dynamic lookup questions when the source API does not expose
# the option set. We deliberately create/reuse single-line Jira text fields
# instead of inventing dropdown values.
webtrigger = Path('src/productionMigrationWebtrigger.ts')
text = webtrigger.read_text()

old_compatible = """function compatible(field: JiraField, requestedType: string): boolean {\n  const actual = jiraKind(field);\n  if ((field.id === 'summary' || field.id === 'description') && ['text', 'paragraph'].includes(requestedType)) return true;\n  if (requestedType === 'checkbox') return actual === 'select';\n  return actual === requestedType;\n}\n"""
new_compatible = """function compatible(field: JiraField, requestedType: string): boolean {\n  const actual = jiraKind(field);\n  if ((field.id === 'summary' || field.id === 'description') && ['text', 'paragraph'].includes(requestedType)) return true;\n  if (requestedType === 'checkbox') return actual === 'select';\n  // Ivanti dynamic lookup option sets are not exposed by the available on-prem\n  // OData API. Preserve these questions as text rather than omitting them or\n  // fabricating select options.\n  if (requestedType === 'lookup-select') return actual === 'text';\n  return actual === requestedType;\n}\n"""
if old_compatible not in text:
    raise SystemExit('compatible anchor not found')
text = text.replace(old_compatible, new_compatible)

anchor = """function compatible(field: JiraField, requestedType: string): boolean {\n"""
helper = """async function ensureLookupFallbackFields(existing: JiraField[], services: SourceService[]): Promise<JiraField[]> {\n  const merged = [...existing];\n  const lookupNames = [...new Set(services.flatMap((service) =>\n    (service.fields ?? [])\n      .filter((field) => String(field.jiraType ?? '').toLowerCase() === 'lookup-select')\n      .map((field) => String(field.name ?? '').trim())\n      .filter(Boolean)\n  ))];\n\n  for (const sourceName of lookupNames) {\n    const candidates = [sourceName, `${sourceName} - Ivanti`];\n    const reusable = merged.find((field) =>\n      candidates.some((candidate) => normalise(field.name) === normalise(candidate)) && jiraKind(field) === 'text'\n    );\n    if (reusable) continue;\n\n    const createResponse = await api.asApp().requestJira(route`/rest/api/3/field`, {\n      method: 'POST',\n      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },\n      body: JSON.stringify({\n        name: `${sourceName} - Ivanti`,\n        description: `Migrated from an Ivanti dynamic lookup. The available Ivanti API does not expose this lookup's option set, so this field is temporarily free text to preserve the source question without inventing values.`,\n        type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',\n        searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'\n      })\n    });\n    const created = await parseJira<JiraField>(createResponse);\n    if (!created?.id) throw new Error(`Jira did not return an ID for lookup fallback field ${sourceName}.`);\n    merged.push(created);\n  }\n  return merged;\n}\n\n"""
if helper not in text:
    if anchor not in text:
        raise SystemExit('compatible function anchor not found')
    text = text.replace(anchor, helper + anchor)

text = text.replace("""    const jiraFields = await getAllFields();\n""", """    let jiraFields = await getAllFields();\n    jiraFields = await ensureLookupFallbackFields(jiraFields, payload.services);\n""")

text = text.replace("""      if (requestedType === 'lookup-select') return undefined;\n""", "")

webtrigger.write_text(text)
print('Applied source-preserving free-text fallback for Ivanti dynamic lookup questions')
