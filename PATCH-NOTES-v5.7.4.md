# v5.7.4 — Forms condition compatibility fix

Fixes the Atlassian Forms validation error:

- `/design/conditions/<id>/i/co is missing`

Each generated advanced condition now includes the required legacy-compatible:

```json
"co": {
  "cIds": {}
}
```

alongside the existing `operator`, `groups`, and `checks` structure.

No changes were made to:
- request type reuse
- Jira work type mapping
- Form question/layout population
- Form read-back verification
- publication
- duplicate request type handling
- portal validation

This is a focused conditional-logic compatibility patch.
