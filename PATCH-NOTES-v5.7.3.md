# v5.7.3 — Forge backend compile fix

Fixes the backend TypeScript errors still present in v5.7.2 by explicitly typing duplicate request type IDs as strings and replacing the nonexistent `apiErrorMessage()` call with the existing `apiErrorDetail()` helper.
