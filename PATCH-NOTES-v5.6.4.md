# v5.6.4 — Request type repair + real Form population verification

## Request type repair
- Ensures the migrated Jira work/issue type is added to the target project's existing issue type scheme before JSM request-type creation.
- Reuses a same-name request type only when it points to the expected Jira issue type.
- Prevents additional duplicates on repeated runs.
- Reports older same-name duplicates for review rather than deleting them automatically.

## Real Form population
- Writes question extension nodes into the Forms ADF `design.layout`, which is what Jira actually renders in the Form builder.
- Preserves the 31 linked Jira field questions and Ivanti section headings.
- Reads the saved Form template back from Jira and verifies both question definitions and rendered layout question extensions.
- Publishes only after the read-back verification succeeds.
- Keeps Ivanti conditions as a reviewed step until their section-target mapping is fully validated.

## Safety
Existing duplicate request types are not deleted automatically.
