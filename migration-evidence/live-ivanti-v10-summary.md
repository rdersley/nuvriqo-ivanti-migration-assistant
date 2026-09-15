# Live Ivanti discovery – v10 summary

## Result
The FRS-prefixed metadata probe completed against the live Ivanti API and found **0 accessible FRS configuration collections**.

- Objects probed: 13
- Working objects: 0
- Known ID hits: 0
- All FRS-prefixed candidates returned HTTP 404

This confirms that the on-prem API exposes operational business objects such as ServiceReqs and Tasks, but does not expose the workflow/configuration metadata collections through the tested OData businessobject routes.

## Reliable live evidence retained
The v8 historical join remains the strongest source of truth for fulfilment behaviour:

- 14 target request templates matched
- 2,869 historical linked tasks mapped back to the target services
- Real WorkflowBlockId values observed on task instances
- Stable repeated task blocks identified for Employee Move, Leaver and Suspend Temporary Access
- Vector provisioning/decommissioning task blocks identified, but with sparse samples and dynamic task subjects

## High-confidence observed task blocks

### Employee Move
- C604EF9EB7174DFB87BF947671AA00EC – MDM setup
- C5DA366AE68F4B9991A6DA09D1198188 – Active Directory - Move Employee
- 18139C3EB12241F98A9709ABEC724C4F – Firewall/ VPN access/ Cisco VPN
- B7753546347140709363F68CC694B63E – Office 365 - confirm O365 licenses
- B81025807A6F4396B2419548A2F91C82 – Vector
- 54A7CD6C195F42B6B8FAB3A244F395A9 – Assets - Check
- B91BFB3316CF40BFA93E06A26E539BAA – Jira
- 7F63B6E135FE4A6F8BA344DB4E630FAF – Physical access to the building and secure room(s).

### Leaver
- CCCA8FA0633549A7952C836A29237091 – Remove VPN access
- 00E2AF830D8C45C3B816F1A4C3FE7569 – Deactivate MDM Accounts
- 329DE1E6ED8E4176A139B41244B3F860 – Disable access to Vector (Test, UAT, PROD)
- E4EA989AB1E74314824D0848A76C3566 – Disable Office 365
- FBF6979F2251435BA48CD71E8649E92D – Disable user in Active Directory
- CFFF0DC25BAE44B1A1414D490526A5D6 – Deactivate Slack Account
- A641216429DC42B9B176AB6F8AB931BD – Deactivate Jira Account
- E85FBFD57D8F4C2D81B58D6BDB84A489 – Remove Physical access to the building and secure room(s).
- C557F58A53744C06921428BA08A7A557 – Reclaim IT Assets
- CE58B23ECA574A61A9612F293C8F1D7C – Leaver is contractor

### Suspend Temporary Access
- E4EA989AB1E74314824D0848A76C3566 – Disable Office 365
- CCCA8FA0633549A7952C836A29237091 – Remove VPN access
- CFFF0DC25BAE44B1A1414D490526A5D6 – Deactivate Slack Account
- FBF6979F2251435BA48CD71E8649E92D – Disable user in Active Directory
- 329DE1E6ED8E4176A139B41244B3F860 – Disable access to Vector (Test, UAT, PROD)
- A641216429DC42B9B176AB6F8AB931BD – Deactivate Jira Account

## Safety rule
Do not install an executable Jira orchestration graph from inferred sequence alone. Historical task instances prove child-task identity and assignment patterns, but not every branch condition, gate, approval or ordering rule. High-confidence observed blocks can be used to build candidate graphs for review/QA; ambiguous services remain non-executable until their missing control-flow evidence is obtained or explicitly approved.
