# v6.0 — Workflow Migration Engine

## New workflow source model
The Ivanti XML parser now separates:
- explicit status/state/stage evidence
- directed transition/route/connector evidence
- approvals
- notifications
- ambiguous items requiring review

Every detected status and transition receives a confidence score. A workflow is only marked buildable when the export contains at least two statuses and at least one transition whose source and target can both be resolved.

## Dry-run
The Workflow tab now has **Validate workflow**. It calls Jira Cloud's supported workflow-create validation API and makes no Jira configuration changes.

## Safe creation
**Create v6 workflow** creates a separately named workflow:

`<Service Name> - Ivanti Workflow v6`

The migration engine does not silently overwrite an existing live workflow. Re-running the same v6 build reuses the versioned workflow if it already exists.

## What v6.0 migrates directly
- Jira statuses
- directed status-to-status transitions
- transition names
- source conditions retained as review descriptions

## Deliberate review boundary
v6.0 does not guess unsupported or ambiguous semantics:
- Ivanti approval activities are flagged for JSM approval review.
- Notifications are deferred to the automation migration phase.
- Ambiguous transition conditions are not silently converted into Jira validators/conditions.
- Missing source/target references prevent that transition from being built.

## Test requirement
The current `New Employee Setup` export previously contained no reliable workflow graph. To exercise the new engine, import an Ivanti XML/ROX export that contains workflow/process status and transition metadata.
