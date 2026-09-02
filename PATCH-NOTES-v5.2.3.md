# v5.2.3 patch notes

## Fixed

- Fixes `Migrated fields resolved: 1/31` when newly-created Jira custom fields have not yet been associated with a screen.
- Screen-field resolution now combines system/visible fields from `/rest/api/3/field` with the complete paginated custom-field catalogue from `/rest/api/3/field/search?type=custom`.
- Existing field IDs captured during Create/Reuse continue to take precedence.
- Custom-field results are paginated and de-duplicated by Jira field ID.
- Existing screen, screen scheme and issue-type screen-scheme reuse behaviour is unchanged.
