# v5.0.2 patch

## Workflow reuse

- Uses Jira Cloud’s current `GET /rest/api/3/workflows/search` endpoint to locate an existing workflow by exact name.
- Falls back to the legacy workflow search endpoint where required.
- Reuses the existing workflow ID instead of attempting duplicate creation.
- Keeps the existing issue type, workflow scheme and project-assignment behaviour.
- Makes the Jira structure build safe to run repeatedly.
