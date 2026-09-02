# v6.1 — Automation Migration Engine

## New Automation tab
Each imported Ivanti service now has an Automation tab that turns detectable workflow/business-rule evidence into structured Jira Automation candidates.

Detected candidate types:
- notifications
- assignments
- tasks/activities with assignments
- workflow conditions
- approvals requiring JSM approval design
- Form conditions already implemented natively in JSM Forms

Every candidate shows:
- proposed trigger
- source conditions
- proposed actions
- confidence score
- Ready / Review / Manual status
- reason for manual review where required

## Export automation migration pack
Exports a JSON migration pack containing every candidate and its confidence/review status.

## Important Atlassian API boundary
Atlassian now provides Automation Rule Management REST APIs for creating/updating rules, but the official documentation states that Forge and OAuth2 apps cannot access those resources.

For that reason v6.1 does NOT:
- request or store administrator API tokens
- call unsupported private Automation endpoints
- claim that blueprint rules were created in Jira

The next safe automation step is to generate/import rules through Atlassian's supported Automation JSON import workflow, after validating the site's exported rule structure.

## Works while workflow data is pending
The Automation tab can be tested now. A Request Offering containing no workflow/business-rule metadata may legitimately show few or no candidates. When a dedicated Ivanti Workflow XML is imported in a later version, its activities will feed this same Automation engine.
