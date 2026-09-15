# Live Ivanti workflow evidence — 15 Sep 2026

This document records evidence gathered from the live Retail inMotion Ivanti Neurons for ITSM OData API through a VPN-connected read-only exporter. It is intentionally separate from the production migration branch until the reconstructed Jira orchestration graphs are reviewed and validated.

## Confirmed target set

All 14 migrated request offerings were matched to live `ServiceReqTemplates` records and linked template-definition RecIds.

## Historical workflow evidence

A bulk read-only export joined live `ServiceReqs` to live `Tasks` locally through `SvcReqTmplLink_RecID` -> Service Request `RecId` -> Task `ParentLink_RecID`.

| Service | Historical requests observed | Linked tasks observed | Distinct workflow blocks |
|---|---:|---:|---:|
| AWS Account management | 22 | 0 | 0 |
| Bitbucket Cloud Support | 75 | 23 | 1 |
| Domain Password Reset | 16 | 0 | 0 |
| Employee Move | 11 | 30 | 8 |
| Leaver | 317 | 805 | 11 |
| New Application Access Request | 235 | 5 | 0 |
| New IT Software Request | 18 | 5 | 1 |
| New Service Request | 5,461 | 1,935 | 1 |
| New Vector System Provisioning | 4 | 5 | 4 |
| Production Vector System Decommissioning | 8 | 15 | 7 |
| Suspend Temporary Access | 6 | 11 | 6 |
| Test Vector System Decommissioning | 4 | 10 | 5 |
| UAT Vector System Decommissioning | 5 | 18 | 7 |
| cBase Leaver | 2 | 7 | 1 |

Total linked tasks observed across the 14 services: 2,869.

## Strong repeatable task evidence

### Employee Move
Observed reusable workflow blocks include:
- MDM setup
- Active Directory - Move Employee
- Firewall / VPN access / Cisco VPN
- Office 365 - confirm O365 licenses
- Vector
- Assets - Check
- Jira
- Physical access to the building and secure room(s)

### Leaver
Observed reusable workflow blocks include:
- Remove VPN access
- Deactivate MDM Accounts
- Disable access to Vector (Test, UAT, PROD)
- Disable Office 365
- Disable user in Active Directory
- Deactivate Slack Account
- Deactivate Jira Account
- Remove physical access
- Reclaim IT Assets
- Contractor branch

### Suspend Temporary Access
Observed reusable blocks include:
- Disable Office 365
- Remove VPN access
- Deactivate Slack Account
- Disable user in Active Directory
- Disable Vector access
- Deactivate Jira Account

### Vector decommissioning
Production, Test and UAT histories expose distinct blocks for combinations of:
- DNS removal
- proxy configuration removal
- database removal
- web-server removal
- file-server data removal
- monitoring removal
- reports removal

These task names vary with the target system/customer, so historical subjects must not be copied literally into a static Jira graph without parameterisation.

## Exact workflow-object API result

A targeted extractor tried 42 observed `WorkflowBlockId` values, 34 live template-definition RecIds and 2 unresolved lookup RecIds against:
- `WorkflowBlocks`
- `WorkflowBlock`
- `WorkflowDefinitions`
- `WorkflowDefinition`
- `Workflows`
- `ValidationLists`
- `ValidationListValues`
- `ValidationBusinessObjects`
- `PickLists`

It tried OData single-key URLs and multiple `$filter` forms. Result: **0 exact object hits** across 1,298 attempts; responses were 404 or 400. Therefore the public business-object OData surface in this tenant does not currently expose those metadata records through the tested names/routes.

## Safety decision

Do not install guessed executable Jira orchestration graphs from task frequency alone. The Forge runtime can already create Jira subtasks and reconcile graph nodes, but installing an inferred graph as if it were exact would risk creating incorrect child issues. Historical evidence should be converted into reviewable workflow candidates first, with source confidence and conditional/optional blocks clearly marked.

## Lookup progress

Historical `ServiceReqApprovalParams` data confirms the `Department` answer used by **New Application Access Request** and exposes observed values such as Engineering, Finance, HR, IT Operations, Operations, Product and Product Management. This is evidence for one of the seven unresolved lookup-backed form occurrences, but it is not yet a complete authoritative validation-list export and must not be treated as the full pick-list.

## Next discovery path

The next read-only probe should try Ivanti system-object naming variants, especially `FRS_` / `Frs_` prefixed business objects, because Ivanti documentation confirms system metadata tables/business objects commonly use the `FRS_` prefix. If those objects remain hidden, the migration will use the historical task evidence as a reconstruction source with explicit confidence gates rather than pretending the workflow metadata was exported directly.
