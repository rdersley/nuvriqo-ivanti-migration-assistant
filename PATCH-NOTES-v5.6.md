# Ivanti Migration Assistant v5.6

This release combines the planned v5.3-v5.6 JSM work into one migration build.

## Added
- Live JSM request-type create/reuse using Atlassian's current Cloud API.
- JSM Form generation from imported Ivanti sections and field mappings.
- Form publishing to the created/reused portal request type.
- Conditional-rule payload generation from the inferred Ivanti conditions.
- Portal verification after build.
- Idempotent request-type and Form reuse/update behavior.
- Results panel showing request type, Form and portal verification.

## Important Atlassian limitation
New request types are created with no portal groups by Atlassian's API, so they are hidden from the customer portal until assigned to a request-type group. The public Cloud API exposes request-type-group retrieval but does not expose a supported operation to assign a request type to a group. v5.6 therefore verifies and clearly reports this final reviewed portal-group step.

## Permissions
The manifest now includes JSM request-type read/write scopes. `forge install --upgrade` is required after deployment so the new permissions can be granted.

## Experimental APIs
Atlassian currently marks request-type creation and parts of the Forms API as experimental. v5.6 opts into those APIs explicitly and reports API failures instead of silently claiming success.
