# v5.7 — JSM service finishing

## Conditional form logic
- Attempts to translate inferred Ivanti `equals` conditions into Atlassian Forms advanced section conditions.
- Uses the current supported `operator/groups/checks` condition structure.
- Reads conditions back from Jira to verify persistence.
- Falls back safely to the populated Form when a condition cannot be mapped.

## Duplicate request types
- Continues to reuse one canonical request type.
- Surfaces same-name duplicates.
- Adds an explicit, confirmation-protected duplicate removal action.
- Never deletes the canonical request type.

## Final JSM validation
- Verifies the request type is linked to the expected Jira work type.
- Verifies a published JSM Form is attached.
- Retrieves portal request-type groups and reports portal visibility.
- Provides a precise manual portal-group step when the request type is hidden.

## Atlassian limitation
The public JSM create-request-type API leaves request type groups empty. v5.7 therefore does not use unsupported/private APIs to assign a portal group automatically.
