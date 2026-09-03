from pathlib import Path

p=Path('static/src/App.tsx')
s=p.read_text()
needle="""  function validationFor(service: MigrationService) {
    const fieldBuilt = service.build.fieldResults.filter((r) => ['created', 'reused'].includes(r.status)).length;
"""
replacement="""  function validationFor(service: MigrationService) {
    // Validation must survive a browser reload. Treat an exact Jira field-name match as
    // live evidence, while retaining build-session evidence when it is available.
    const builtNames = new Set(service.build.fieldResults.filter((r) => ['created', 'reused'].includes(r.status)).map((r) => r.name.trim().toLowerCase()));
    const jiraNames = new Set(existingJiraFields.map((field) => field.name.trim().toLowerCase()));
    const fieldBuilt = service.analysis.fields.filter((field) => builtNames.has(field.name.trim().toLowerCase()) || jiraNames.has(field.name.trim().toLowerCase())).length;
"""
if needle not in s:
    raise SystemExit('validationFor anchor not found')
s=s.replace(needle,replacement,1)

# Add a live refresh action to validation page. getFields is safe/read-only and restores
# field evidence after reload. Existing request/Form evidence is preserved by the app's
# normal JSM build/readback flow until dedicated discovery endpoints are available.
needle2="""<div className=\"row\"><div><p className=\"eyebrow dark\">Migration assurance</p><h1>Test & Validation Centre</h1><p className=\"hint\">See which services are ready, blocked by source data, or still need Jira/manual verification.</p></div></div>"""
replacement2="""<div className=\"row\"><div><p className=\"eyebrow dark\">Migration assurance</p><h1>Test & Validation Centre</h1><p className=\"hint\">See which services are ready, blocked by source data, or still need Jira/manual verification. Jira field evidence is rediscovered live after reload.</p></div><button className=\"secondary\" onClick={async()=>{try{const fields=await invoke('getFields') as unknown as JiraField[];setExistingJiraFields(fields);setSuccessMessage(`Live Jira validation refreshed: ${fields.length} Jira fields discovered.`);}catch(error){setMessage(`Live Jira validation failed: ${error instanceof Error ? error.message : String(error)}`);}}}>Refresh live Jira evidence</button></div>"""
if needle2 not in s:
    raise SystemExit('validation page anchor not found')
s=s.replace(needle2,replacement2,1)
p.write_text(s)
print('Applied live Jira validation readback fix')
