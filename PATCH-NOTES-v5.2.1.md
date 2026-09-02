# v5.2.1 – Issue Type Screen Scheme Mapping Fix

This patch fixes the Jira error `400: The default mapping is missing.` returned when creating an issue type screen scheme.

## Changes

- New issue type screen schemes are created with both:
  - a required `default` mapping to the generated screen scheme; and
  - the migrated issue type mapping.
- Reused issue type screen schemes are checked and repaired if their default mapping is missing or points to a different screen scheme.
- Reused schemes also verify the migrated issue type mapping and replace it when necessary.
- All existing v5.2 screen, field, workflow and reuse behaviour is preserved.

The patch follows Atlassian's Jira Cloud REST v3 issue type screen scheme model, where the create payload includes an `issueTypeId` of `default` for the default mapping.
