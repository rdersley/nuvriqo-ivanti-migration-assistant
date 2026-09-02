# v5.7.2 — Forge backend TypeScript compile fix

Fixes the backend TypeScript errors found during `forge deploy` in v5.7.1:

- Explicitly types duplicate request type IDs as `string[]`.
- Removes the nonexistent `apiErrorMessage()` call.
- Reuses the existing `apiErrorDetail()` helper and safely converts the result to a message.

No Jira/JSM migration behaviour has otherwise changed.
