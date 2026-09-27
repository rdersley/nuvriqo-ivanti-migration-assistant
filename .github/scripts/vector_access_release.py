#!/usr/bin/env python3
"""Guarded, idempotent Vector Access Request release for IT Help only.

Creates or reuses the issue type, request type, approval-workflow mapping,
portal group and Jira fields. The Form itself is built by the Forge
vector-access-release webtrigger because the Forms API needs asApp access.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

SITE_HOST = os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
SITE = SITE_HOST if SITE_HOST.startswith(('http://', 'https://')) else f'https://{SITE_HOST}'
AUTH = base64.b64encode(f"{os.environ['FORGE_EMAIL']}:{os.environ['FORGE_API_TOKEN']}".encode()).decode()
HEAD = {'Authorization': f'Basic {AUTH}', 'Accept': 'application/json', 'Content-Type': 'application/json'}
PROJECT_KEY = 'IT'
PROJECT_ID = '12789'
SERVICE_DESK_ID = '2183'
WORKFLOW_SCHEME_ID = '12635'
APPROVAL_WORKFLOW = 'IT: Service Request Fulfilment with Approvals workflow for Jira Service Management'
PORTAL_GROUP_ID = '2258'
PORTAL_GROUP_NAME = 'Logins and Accounts'
SERVICE_NAME = 'Vector Access Request'
SOURCE_REC_ID = '8A12298C44EC42309B53935D6F34E11D'
SERVICE_DESCRIPTION = 'Vector systems accounts requests'
# Every Jira field is Vector-specific so no field shared with other projects is touched.
FIELD_SUFFIX = ' - Vector Access'
OUT = Path('migration-output/vector-access-release')
OUT.mkdir(parents=True, exist_ok=True)

TYPE_DEF = {
    'text': ('com.atlassian.jira.plugin.system.customfieldtypes:textfield', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
    'paragraph': ('com.atlassian.jira.plugin.system.customfieldtypes:textarea', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
    'date': ('com.atlassian.jira.plugin.system.customfieldtypes:datepicker', 'com.atlassian.jira.plugin.system.customfieldtypes:daterange'),
    'select': ('com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
    'checkbox': ('com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
    'user': ('com.atlassian.jira.plugin.system.customfieldtypes:userpicker', 'com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher'),
}

# Live Ivanti validation lists, read 2026-09-27.
# CustomerList (AEB71B7162F0457A809E1A55CCE4CA30), all 37 CustomerName values.
VECTOR_SYSTEMS = [
    'Aegean Airlines (AEE)', 'Aer Lingus (EIN)', 'American Airlines (AA)', 'American Airlines (L-US)',
    'American Airlines Regional', 'Austrian OBR (AUA)', 'Brussels (BRU)', 'Chair Airlines (GSW)', 'Condor (CFG)',
    'Easyjet (EZY) NOT VIA IVANTI See Ivanti Q&A#10129*', 'Edelweiss (EDW)', 'Eurowings (EWG)',
    'Eurowings Discover (OCN)', 'Flybondi (FBD) - Decommissioned', 'Flydubai (FDB)', 'Frontier Airlines (FFT)',
    'Hong Kong Express (HKE)', 'Jazeera (JZR)', 'Jet2 (EXS)', 'KLM', 'Lufthansa OBR (DLHOBR)', 'Marabu MBU', 'RIM',
    'Royal Air Maroc (RAM)', 'Ryanair (RYR)', 'Sales Demo - UAT Only', 'Spirit (NKS)', 'Sunclass Airlines (VKG)',
    'Sunclass Retail (VKR)', 'Swiss OBR (SWROBR)', 'TUI Group (TUI)', 'VIVA Aerobus (VIV)',
    "Vector X 'Preorders': Alaska (ASA)", "Vector X 'Preorders': Edelweiss (EDW)",
    "Vector X 'Preorders': Germania Chair (GMI)", "Vector X 'Preorders': Spirit - NKS",
    "Vector X 'Preorders': Vector X Cloud",
]
# VectorSystemType, all 4 values in Ivanti order.
VECTOR_TYPES = ['Test', 'UAT', 'STAGE', 'Production']
# VectorAccountRole (1AF86DB16C114B00B201908114BEE51A), all 9 role descriptions.
VECTOR_ROLES = ['Account Manager', 'Business Analyst', 'Developer', 'Finance', 'Hardware', 'IT Operations',
                'Quality Assurance', 'SD - First Line', 'SD - Second Line']

# Customer-input questions from offering 8A12298C44EC42309B53935D6F34E11D.
# The always-hidden userdisplayname helper is intentionally excluded.
# Keep in step with SOURCES in src/vectorAccessWebtrigger.ts.
FIELDS = [
    {'name': 'New Vector Account', 'type': 'select', 'options': ['Yes', 'No']},
    {'name': 'Password reset or Modify?', 'type': 'select', 'options': ['Password Reset', 'Account Modifications']},
    {'name': 'Business Case', 'type': 'paragraph', 'description': 'Why is this needed? Please give details'},
    {'name': 'User Name', 'type': 'user', 'description': 'Name of user for whom Vector account is needed'},
    {'name': 'User Email', 'type': 'text'},
    {'name': 'Vector system', 'type': 'select', 'options': VECTOR_SYSTEMS},
    {'name': 'OBR', 'type': 'checkbox'},
    {'name': 'What type of Vector System', 'type': 'select', 'options': VECTOR_TYPES},
    {'name': 'Super Admin', 'type': 'select', 'options': ['Yes', 'No'], 'description': 'Is Super Admin role required'},
    {'name': 'Super Admin details', 'type': 'paragraph', 'description': 'Give some details of why Super Admin is required'},
    {'name': 'Super Admin from', 'type': 'date'},
    {'name': 'Super Admin to', 'type': 'date'},
    {'name': 'User Permissions', 'type': 'select', 'options': VECTOR_ROLES},
    {'name': 'Additional requested modifications', 'type': 'paragraph'},
    {'name': 'Pre approved For Test', 'type': 'checkbox'},
    {'name': 'SelfCreate Test', 'type': 'checkbox'},
    {'name': 'Pre approved for UAT', 'type': 'checkbox'},
    {'name': 'SelfCreate UAT', 'type': 'checkbox'},
    {'name': 'Pre approved for Prod', 'type': 'checkbox'},
    {'name': 'SelfCreate Prod', 'type': 'checkbox'},
]

def call(method, path, body=None, extra=None, timeout=90):
    allowed = (
        '/rest/api/3/project/', '/rest/api/3/issuetype', '/rest/api/3/issuetypescheme/',
        '/rest/api/3/field', '/rest/api/3/workflowscheme/', '/rest/servicedeskapi/servicedesk/2183/',
        '/rest/servicedesk/1/servicedesk/12789/',
    )
    decoded = urllib.parse.unquote(path).lower()
    if not decoded.startswith(tuple(x.lower() for x in allowed)):
        raise RuntimeError(f'Path outside IT-only allow-list: {method} {path}')
    headers = dict(HEAD)
    headers.update(extra or {})
    data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
    request = urllib.request.Request(SITE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode('utf-8', 'replace')
            try: parsed = json.loads(raw) if raw else {}
            except Exception: parsed = raw
            return response.status, parsed
    except urllib.error.HTTPError as error:
        raw = error.read().decode('utf-8', 'replace')
        try: parsed = json.loads(raw) if raw else {}
        except Exception: parsed = raw
        return error.code, parsed

def require(status, body, accepted, label):
    if status not in accepted:
        raise RuntimeError(f'{label} failed: HTTP {status} {str(body)[:1000]}')
    return body

def norm(value):
    return ' '.join(str(value or '').casefold().split())

def field_kind(field):
    custom = str((field.get('schema') or {}).get('custom') or '')
    if 'textarea' in custom: return 'paragraph'
    if 'textfield' in custom: return 'text'
    if 'datepicker' in custom: return 'date'
    if 'userpicker' in custom: return 'user'
    if custom.endswith(':select'): return 'select'
    return None

def compatible(field, wanted):
    return field_kind(field) == ('select' if wanted == 'checkbox' else wanted)

def all_fields():
    status, base = call('GET', '/rest/api/3/field')
    require(status, base, {200}, 'field inventory')
    merged = {str(f.get('id')): f for f in base if isinstance(f, dict) and f.get('id')}
    start = 0
    while True:
        status, page = call('GET', f'/rest/api/3/field/search?type=custom&startAt={start}&maxResults=100')
        require(status, page, {200}, 'custom field inventory')
        values = page.get('values') or []
        for field in values:
            if field.get('id'): merged[str(field['id'])] = field
        start += len(values)
        if not values or start >= int(page.get('total') or 0): break
    return list(merged.values())

def ensure_options(field_id, values):
    if not values: return
    status, contexts = call('GET', f'/rest/api/3/field/{field_id}/context?startAt=0&maxResults=100')
    require(status, contexts, {200}, f'context inventory for {field_id}')
    context_id = str((contexts.get('values') or [{}])[0].get('id') or '')
    if not context_id: raise RuntimeError(f'No context for {field_id}')
    status, current = call('GET', f'/rest/api/3/field/{field_id}/context/{context_id}/option?startAt=0&maxResults=1000')
    require(status, current, {200}, f'option inventory for {field_id}')
    existing = {norm(item.get('value')) for item in current.get('values') or []}
    missing = [value for value in values if norm(value) not in existing]
    if missing:
        status, result = call('POST', f'/rest/api/3/field/{field_id}/context/{context_id}/option', {'options': [{'value': x} for x in missing]})
        require(status, result, {200, 201}, f'option creation for {field_id}')

def ensure_fields():
    catalogue = all_fields()
    by_name = defaultdict(list)
    for item in catalogue: by_name[norm(item.get('name'))].append(item)
    resolved = {}
    results = []
    for source in FIELDS:
        name, wanted = source['name'], source['type']
        jira_name = f'{name}{FIELD_SUFFIX}'
        same = by_name.get(norm(jira_name), [])
        matches = [item for item in same if compatible(item, wanted)]
        if len(matches) > 1: raise RuntimeError(f'Multiple {jira_name} fields exist; refusing ambiguous reuse')
        if same and not matches: raise RuntimeError(f'{jira_name} exists with an incompatible type')
        if matches:
            selected = matches[0]
            state = 'reused'
        else:
            custom_type, searcher = TYPE_DEF[wanted]
            status, selected = call('POST', '/rest/api/3/field', {
                'name': jira_name,
                'description': source.get('description') or f'Migrated from Ivanti {SERVICE_NAME}.',
                'type': custom_type,
                'searcherKey': searcher,
            })
            require(status, selected, {200, 201}, f'field creation for {name}')
            by_name[norm(jira_name)].append(selected)
            state = 'created'
        field_id = str(selected.get('id') or '')
        if not field_id: raise RuntimeError(f'No Jira field ID for {name}')
        if wanted in {'select', 'checkbox'}:
            ensure_options(field_id, source.get('options') or ['Yes', 'No'])
        resolved[name] = field_id
        results.append({'sourceName': name, 'jiraName': selected.get('name'), 'jiraFieldId': field_id, 'status': state})
    return resolved, results

def ensure_issue_and_request_type():
    status, types = call('GET', '/rest/api/3/issuetype')
    require(status, types, {200}, 'issue type inventory')
    matches = [item for item in types if norm(item.get('name')) == norm(SERVICE_NAME) and not item.get('subtask')]
    if len(matches) > 1: raise RuntimeError(f'Multiple {SERVICE_NAME} issue types exist; refusing ambiguous reuse')
    if matches:
        issue_type = matches[0]
        issue_state = 'reused'
    else:
        status, issue_type = call('POST', '/rest/api/3/issuetype', {
            'name': SERVICE_NAME,
            'description': SERVICE_DESCRIPTION,
            'type': 'standard',
        })
        require(status, issue_type, {200, 201}, 'issue type creation')
        issue_state = 'created'
    issue_type_id = str(issue_type.get('id') or '')
    if not issue_type_id: raise RuntimeError(f'Jira did not return a {SERVICE_NAME} issue type ID')

    status, association = call('GET', f'/rest/api/3/issuetypescheme/project?projectId={PROJECT_ID}')
    require(status, association, {200}, 'issue type scheme association')
    rows = association.get('values') or []
    row = next((x for x in rows if PROJECT_ID in [str(v) for v in x.get('projectIds') or []]), None)
    scheme_id = str(((row or {}).get('issueTypeScheme') or {}).get('id') or '')
    if not scheme_id: raise RuntimeError('Could not resolve the IT issue type scheme')
    status, mappings = call('GET', f'/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId={scheme_id}&maxResults=500')
    require(status, mappings, {200}, 'issue type scheme mapping')
    current = {str(v.get('issueTypeId')) for v in mappings.get('values') or []}
    if issue_type_id not in current:
        status, body = call('PUT', f'/rest/api/3/issuetypescheme/{scheme_id}/issuetype', {'issueTypeIds': [issue_type_id]})
        require(status, body, {200, 204}, 'IT issue type association')

    status, listing = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
    require(status, listing, {200}, 'request type inventory')
    same = [item for item in listing.get('values') or [] if norm(item.get('name')) == norm(SERVICE_NAME)]
    exact = next((item for item in same if str(item.get('issueTypeId')) == issue_type_id), None)
    if same and not exact: raise RuntimeError(f'{SERVICE_NAME} request type exists against a different issue type')
    if exact:
        request_type = exact
        request_state = 'reused'
    else:
        status, request_type = call('POST', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype', {
            'name': SERVICE_NAME,
            'description': f'Migrated from Ivanti: {SERVICE_NAME}',
            'helpText': 'Use this request to create, modify or reset a Vector system account.',
            'issueTypeId': issue_type_id,
        }, {'X-ExperimentalApi': 'opt-in'})
        require(status, request_type, {200, 201}, 'request type creation')
        request_state = 'created'
    request_type_id = str(request_type.get('id') or '')
    if not request_type_id: raise RuntimeError(f'Jira did not return a {SERVICE_NAME} request type ID')
    return issue_type_id, request_type_id, issue_state, request_state, scheme_id

def map_workflow(issue_type_id):
    status, result = call('GET', f'/rest/api/3/workflowscheme/project?projectId={PROJECT_ID}')
    require(status, result, {200}, 'workflow scheme association')
    row = next((x for x in result.get('values') or [] if PROJECT_ID in [str(v) for v in x.get('projectIds') or []]), None)
    scheme = (row or {}).get('workflowScheme') or {}
    if str(scheme.get('id')) != WORKFLOW_SCHEME_ID:
        raise RuntimeError(f'IT workflow scheme guard failed: {scheme.get("id")}')
    if any(str(v) != PROJECT_ID for v in (row or {}).get('projectIds') or []):
        raise RuntimeError('IT workflow scheme is shared; refusing workflow update')
    desired = dict(scheme.get('issueTypeMappings') or {})
    if desired.get(issue_type_id) == APPROVAL_WORKFLOW:
        return 'already-mapped'
    desired[issue_type_id] = APPROVAL_WORKFLOW
    status, draft = call('GET', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/draft')
    if status == 404:
        status, created = call('POST', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/createdraft')
        require(status, created, {200, 201}, 'workflow draft creation')
        status, draft = call('GET', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/draft')
    require(status, draft, {200}, 'workflow draft read')
    status, body = call('PUT', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/draft', {
        'name': draft.get('name') or scheme.get('name'),
        'description': draft.get('description') or scheme.get('description') or '',
        'defaultWorkflow': draft.get('defaultWorkflow') or scheme.get('defaultWorkflow'),
        'issueTypeMappings': desired,
        'updateDraftIfNeeded': True,
    })
    require(status, body, {200, 204}, 'workflow draft update')
    # The new issue type starts on the scheme default workflow (Open/Reopened);
    # both map to Waiting for Support, as for the other migrated types.
    status, body = call('POST', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/draft/publish', {
        'statusMappings': [
            {'issueTypeId': issue_type_id, 'statusId': '1', 'newStatusId': '10121'},
            {'issueTypeId': issue_type_id, 'statusId': '4', 'newStatusId': '10121'},
        ]
    })
    require(status, body, {200, 204}, 'workflow publish')
    for _ in range(12):
        status, live = call('GET', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}')
        if status == 200 and (live.get('issueTypeMappings') or {}).get(issue_type_id) == APPROVAL_WORKFLOW:
            return 'published'
        time.sleep(5)
    raise RuntimeError(f'{SERVICE_NAME} workflow mapping did not persist')

def assign_portal_group(request_type_id):
    path = f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{PORTAL_GROUP_ID}/request-types/{request_type_id}'
    status, current = call('GET', path)
    require(status, current, {200}, 'portal group identity read')
    if str(current.get('id')) != request_type_id or int(current.get('projectId') or 0) != int(PROJECT_ID) or current.get('name') != SERVICE_NAME:
        raise RuntimeError('Portal group identity guard failed')
    payload = dict(current)
    payload['groups'] = [{'id': int(PORTAL_GROUP_ID), 'name': PORTAL_GROUP_NAME}]
    status, result = call('PUT', path, payload)
    require(status, result, {200}, 'portal group assignment')
    status, readback = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{request_type_id}')
    require(status, readback, {200}, 'portal group readback')
    if PORTAL_GROUP_ID not in [str(x) for x in readback.get('groupIds') or []]:
        raise RuntimeError(f'{PORTAL_GROUP_NAME} group assignment did not persist')

def main():
    if SITE_HOST.lower() != 'retailinmotion.atlassian.net':
        raise RuntimeError('Site guard failed')
    status, project = call('GET', f'/rest/api/3/project/{PROJECT_KEY}')
    require(status, project, {200}, 'IT project guard')
    if str(project.get('id')) != PROJECT_ID or project.get('key') != PROJECT_KEY:
        raise RuntimeError('IT project identity guard failed')

    issue_type_id, request_type_id, issue_state, request_state, issue_scheme_id = ensure_issue_and_request_type()
    workflow_state = map_workflow(issue_type_id)
    assign_portal_group(request_type_id)
    field_map, field_results = ensure_fields()

    status, request_type = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{request_type_id}')
    require(status, request_type, {200}, 'final request type readback')
    report = {
        'ok': True,
        'target': {'projectKey': PROJECT_KEY, 'projectId': PROJECT_ID, 'serviceDeskId': SERVICE_DESK_ID, 'workflowSchemeId': WORKFLOW_SCHEME_ID, 'issueTypeSchemeId': issue_scheme_id},
        'sourceOffering': {'name': SERVICE_NAME, 'recId': SOURCE_REC_ID},
        'issueType': {'id': issue_type_id, 'status': issue_state},
        'requestType': {'id': request_type_id, 'status': request_state, 'groupIds': request_type.get('groupIds')},
        'form': {'status': 'pending-forge-asApp', 'questions': len(FIELDS)},
        'workflow': {'name': APPROVAL_WORKFLOW, 'status': workflow_state},
        'fields': {'created': sum(x['status'] == 'created' for x in field_results), 'reused': sum(x['status'] == 'reused' for x in field_results), 'results': field_results},
        'qaTicketsCreated': 0,
    }
    (OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'fields'}, indent=2))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        report = {'ok': False, 'error': str(error), 'target': {'projectKey': PROJECT_KEY, 'projectId': PROJECT_ID, 'serviceDeskId': SERVICE_DESK_ID}}
        (OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
        sys.exit(2)
