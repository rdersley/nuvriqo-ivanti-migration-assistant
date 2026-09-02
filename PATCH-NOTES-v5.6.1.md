# v5.6.1 — Staged JSM Form Builder

This patch isolates JSM request-type, Form and portal operations so a single Forms validation error no longer hides the useful result.

## Changes

- Keeps JSM request type creation/reuse as its own stage.
- Creates/reuses a minimal schema-valid Form template first.
- Enriches the Form separately with Jira-linked questions and Form sections.
- Uses documented Forms question types and `validation.rq` instead of the invalid `type: jira` payload used in v5.6.
- Adds `sectionType` to Form sections.
- Publishes the last known-valid Form design as a separate stage.
- Does not submit guessed conditional-logic JSON. Ivanti conditions remain visible as a reviewed stage until they can be mapped safely to Atlassian's FormCondition section-target schema.
- Displays the complete Atlassian error response for any Form stage that is rejected.
- Portal verification only runs after successful publication.
- Removes experimental headers from Forms endpoints; the Forms REST endpoints are no longer experimental. The request-type creation endpoint remains experimental and continues to opt in.

## Expected first test

The JSM result panel should show individual rows for:

1. Request type
2. Field resolution
3. Base Form
4. Questions/sections
5. Conditions
6. Publication
7. Portal verification

If Atlassian rejects questions/sections, the base Form remains in the project and the full validation payload is shown on screen.
