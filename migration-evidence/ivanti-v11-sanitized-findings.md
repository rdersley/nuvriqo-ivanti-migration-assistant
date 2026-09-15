# Ivanti v11 Sanitized Migration Findings

Source: local VPN-connected Ivanti OData evidence export `Ivanti-Migration-Evidence-v11-20260915-170659.zip`.

This file intentionally contains aggregate migration evidence only. It excludes API keys, user emails, individual request contents, and unrelated incident data.

## Export scope

- 14 target service request templates
- 14,642 matching historical ServiceReq records retained
- 21,002 linked Tasks retained
- 0 direct Approval records returned from the `Approvals` collection for those parents
- 18 configuration collections queried successfully at HTTP level
- `ServiceReqTemplates` returned 235 real records with 45 observed fields
- Most other configuration collections returned zero records on this Ivanti OData surface
- No bulk Incident export was performed

## Important improvement over earlier evidence

The v11 full paging pass found substantially more historical fulfilment evidence than the earlier capped sample. The 14 target templates account for 21,002 linked task records.

## Current template configuration discovered from live Ivanti

All 14 target templates are `Published (Automatic)` and expose a live `ServiceReqTemplateDefinitionLink_RecID`.

Delivery commitments observed on the live templates:

- Domain Password Reset: 30
- AWS Account management: 1440
- New Application Access Request: 1440
- New IT Software Request: 1440
- Employee Move: 7200
- Bitbucket Cloud Support: 10080
- New Service Request: 10080
- New Vector System Provisioning: 20160
- Production Vector System Decommissioning: 20160
- Test Vector System Decommissioning: 20160
- UAT Vector System Decommissioning: 20160
- Leaver: 43200
- Suspend Temporary Access: 43200
- cBase Leaver: 43200

These values are preserved as source facts; units should be confirmed against Ivanti configuration before translating them into Jira SLAs.

Portal/template behaviour observed in ConfigOptions:

- Bitbucket Cloud Support and New Service Request have source `enableCancel=true` and `enableEditing=true`.
- Most other target templates have source editing/cancel options disabled in ConfigOptions.
- Templates are non-external and anonymous submission is disabled.

## Historical request behaviour

All retained requests were created from the target Service Request Templates. `Source` is overwhelmingly/consistently `Self Service` for the 14 targets.

Common source statuses include:

- Closed
- Cancelled
- Active
- Waiting for 3rd Party
- Waiting for Customer
- Submitted
- Fulfilled
- Approval Rejected
- Pending approval
- Leaver (service-specific state)

This is strong evidence that Jira workflow design should preserve at least the operational distinction between active fulfilment, waiting, completion, cancellation and approval-related states instead of reducing everything to a simple To Do / Done flow.

## Approval evidence

Although the `Approvals` collection returned no directly joinable child records, ServiceReq history contains approval state fields and source approver metadata:

- `ApprovalNeeded`
- `DefaultApprover`
- `AdHocApprover`
- `ServiceReqApprovalParams`
- approval-related statuses such as `Pending approval` and `Approval Rejected`

Historical requests with `ApprovalNeeded=Yes` are present for at least:

- AWS Account management
- Bitbucket Cloud Support
- New Application Access Request
- New IT Software Request
- New Service Request
- Production Vector System Decommissioning
- UAT Vector System Decommissioning

Therefore approval behaviour is real source behaviour even though the separate Approval entity is not exposed usefully through this OData route.

## High-confidence task patterns

### Employee Move

175 linked tasks across 23 requests. Seven core tasks appear once for every historical request in the sample:

- Jira
- Active Directory - Move Employee
- Assets - Check
- Office 365 - confirm O365 licenses
- MDM setup
- Firewall/ VPN access/ Cisco VPN
- Vector

Additional conditional tasks include physical building/secure-room access and checking software for the new position.

### Leaver

5,953 linked tasks across 746 historical requests. Very strong recurring offboarding pattern:

- Remove VPN access
- Disable Office 365
- Disable user in Active Directory
- Deactivate Jira Account
- Deactivate MDM Accounts
- Deactivate Slack Account
- Disable access to Vector (Test, UAT, PROD)
- Reclaim IT Assets

Other lower-frequency tasks include physical-access removal, software-specific actions, SQL instances and other application-specific cleanup.

### Suspend Temporary Access

106 linked tasks across 15 requests. Seven source workflow blocks recur for every request:

- Disable user in Active Directory
- Disable Office 365
- Disable access to Vector (Test, UAT, PROD)
- Remove VPN access
- Deactivate MDM Accounts
- Deactivate Jira Account
- Deactivate Slack Account

`Reclaim IT Assets` appears as an additional exceptional task.

### Vector provisioning/decommissioning

The Vector request types expose repeatable workflow-block families for infrastructure fulfilment. Observed task themes include:

- DNS records
- proxy configuration
- webserver removal/addition
- database removal
- file-server data removal
- monitoring (Nagios AWS)
- report-server cleanup
- archival/S3 actions
- review/change-management steps

Subjects often contain environment/customer/system names, so Jira orchestration should preserve a reusable task template with values substituted from the parent request rather than copying literal historic subjects.

### cBase Leaver

Observed recurring cBase Active Directory disablement plus the broader leaver-style software/access cleanup pattern.

## Routing evidence

Historical task/request ownership exposes source routing to teams including:

- First Line Support
- Second Line Support
- MDM
- SRE
- DBA
- Change Management
- Nagios
- Infosec
- other specialised operational teams

This is sufficient to build a source-backed Jira routing matrix, but individual legacy owner identities should not be hard-coded unless separately validated as current Jira users/teams.

## Configuration entities exposed

`ServiceReqTemplates` is the strongest live configuration source. Observed fields include:

- Name / Description / Status
- Owner / OwnerTeam
- DefaultAssignee / DefaultAssigneeTeam
- DeliveryCommitment
- ConfigOptions
- UsageCount
- ServiceRecId / SvcLink
- TemplateCancelable
- IsExternal / IsAllowAnonymousSubmit
- ServiceReqTemplateDefinitionLink_RecID

The following queried collections returned zero real records through this OData surface and must not be treated as proof that the underlying configuration does not exist:

- ServiceReqTemplateParameters
- ServiceRequestTemplateParameters
- Parameters
- RequestOfferings
- ServiceCatalogs
- Categories
- Teams
- OrgUnits
- Organizations
- PickLists
- ValidationBusinessObjects
- ValidationLists
- ValidationListValues
- WorkflowDefinitions
- WorkflowBlocks
- WorkflowActions
- Workflows

## Jira migration implications

1. Keep the 14 source-faithful request types and Forms already created in project IT.
2. Migrate the 12 confirmed conditional form rules from ROX into Jira Forms and verify persisted design by read-back.
3. Build high-confidence child-task orchestration first for Employee Move, Leaver and Suspend Temporary Access using the recurring WorkflowBlock/task evidence.
4. Build parameterised Vector orchestration templates from the recurring block families, not literal historic task subjects.
5. Recreate approval gates for request types where `ApprovalNeeded=Yes` is evidenced historically.
6. Map source owner teams to current Jira assignment/queues only after current-team validation.
7. Use live DeliveryCommitment values as SLA migration evidence, but confirm their Ivanti unit/meaning before creating Jira SLA goals.
8. Preserve waiting, cancellation, approval and fulfilment distinctions in Jira workflow design.
9. Do not invent lookup values or workflow branches that are not supported by ROX or live history.
