#!/usr/bin/env python3
"""Guarded, idempotent New Employee Setup release for IT Help only."""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
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
STANDARD_WORKFLOW = 'IT: Service Request Fulfilment workflow for Jira Service Management'
COMMON_REQUESTS_GROUP_ID = '2256'
SERVICE_NAME = 'New Employee Setup'
FORM_NAME = f'{SERVICE_NAME} - Ivanti Migration Form'
OUT = Path('migration-output/new-employee-demo-release')
OUT.mkdir(parents=True, exist_ok=True)

TYPE_DEF = {
    'text': ('com.atlassian.jira.plugin.system.customfieldtypes:textfield', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
    'paragraph': ('com.atlassian.jira.plugin.system.customfieldtypes:textarea', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
    'date': ('com.atlassian.jira.plugin.system.customfieldtypes:datepicker', 'com.atlassian.jira.plugin.system.customfieldtypes:daterange'),
    'select': ('com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
    'checkbox': ('com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
    'user': ('com.atlassian.jira.plugin.system.customfieldtypes:userpicker', 'com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher'),
}

# Exact customer-input questions from New Employee Setup offering
# F1901A6167B04E3EB2B7664675CCB528. Presentation-only imageField and the
# always-hidden DeptManagerDisplayName helper are intentionally excluded.
FIELDS = [
    {'seq': 2, 'section': 'New Employee Information', 'name': 'First Name', 'type': 'text', 'required': True},
    {'seq': 3, 'section': 'New Employee Information', 'name': 'Last Name', 'type': 'text', 'required': True},
    {'seq': 4, 'section': 'New Employee Information', 'name': 'Department', 'type': 'text', 'required': True, 'description': 'Migrated from the Ivanti department lookup.'},
    {'seq': 5, 'section': 'New Employee Information', 'name': 'SubDepartment', 'type': 'text', 'required': False, 'description': 'Migrated from the Ivanti subdepartment lookup.'},
    {'seq': 6, 'section': 'New Employee Information', 'name': 'Hiring Manager', 'type': 'user', 'required': True},
    {'seq': 7, 'section': 'New Employee Information', 'name': 'Hiring Manager email', 'type': 'text', 'required': True},
    {'seq': 8, 'section': 'New Employee Information', 'name': 'Title', 'type': 'text', 'required': True},
    {'seq': 9, 'section': 'New Employee Information', 'name': 'Employment Type', 'type': 'select', 'required': True, 'options': ['Contract', 'Full Time', 'Part Time']},
    {'seq': 10, 'section': 'New Employee Information', 'name': 'Is user in ServiceDesk', 'type': 'select', 'required': True, 'options': ['Yes', 'No']},
    {'seq': 11, 'section': 'New Employee Information', 'name': 'Start Date', 'type': 'date', 'required': True, 'description': 'Minimum two weeks lead time required'},
    {'seq': 13, 'section': 'Facility Detail', 'name': 'Location', 'type': 'text', 'required': False, 'description': 'Migrated from the Ivanti location lookup.'},
    {'seq': 15, 'section': 'Equipment Details', 'name': 'Computer Required?', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No'], 'description': 'Does the new employee need a computer?'},
    {'seq': 16, 'section': 'Equipment Details', 'name': 'Computer Type', 'type': 'select', 'required': True, 'options': ['Laptop'], 'condition': ('Computer Required?', 'Yes'), 'description': 'All options include standard keyboard and mouse.'},
    {'seq': 17, 'section': 'Equipment Details', 'name': 'Docking station', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No'], 'description': 'Recommended for notebook users using a keyboard, mouse and monitor.'},
    {'seq': 18, 'section': 'Equipment Details', 'name': 'Primary Monitor', 'type': 'select', 'required': False, 'options': ['24 inch LCD']},
    {'seq': 19, 'section': 'Equipment Details', 'name': 'Second Monitor Requested?', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No'], 'condition': ('Computer Required?', 'Yes'), 'description': 'Select Yes if the new employee requires a second monitor.'},
    {'seq': 20, 'section': 'Equipment Details', 'name': 'Secondary Monitor', 'type': 'select', 'required': True, 'options': ['24 inch LCD'], 'condition': ('Second Monitor Requested?', 'Yes')},
    {'seq': 21, 'section': 'Equipment Details', 'name': 'Keyboard and Mouse', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No'], 'condition': ('Computer Required?', 'Yes')},
    {'seq': 22, 'section': 'Equipment Details', 'name': 'Mobile Phone Required?', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No'], 'description': 'Does the new employee need a mobile phone?'},
    {'seq': 23, 'section': 'Equipment Details', 'name': 'Mobile Phone', 'type': 'select', 'required': False, 'options': ['iPhone', 'Samsung'], 'condition': ('Mobile Phone Required?', 'Yes')},
    {'seq': 25, 'section': 'Equipment Details', 'name': 'Test Devices', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No']},
    {'seq': 26, 'section': 'Equipment Details', 'name': 'Additional information', 'type': 'paragraph', 'required': False},
    {'seq': 27, 'section': 'Equipment Details', 'name': 'Is equipment shipping required?', 'type': 'checkbox', 'required': False, 'options': ['Yes', 'No'], 'condition': ('Computer Required?', 'Yes')},
    {'seq': 28, 'section': 'Equipment Details', 'name': 'Employee private email address', 'type': 'text', 'required': True, 'description': 'For shipping purposes'},
    {'seq': 29, 'section': 'Equipment Details', 'name': 'Employee phone number', 'type': 'text', 'required': True, 'condition': ('Is equipment shipping required?', 'Yes'), 'description': 'For shipping purposes'},
    {'seq': 30, 'section': 'Equipment Details', 'name': 'Employee address', 'type': 'paragraph', 'required': True, 'condition': ('Is equipment shipping required?', 'Yes'), 'description': 'For shipping purposes'},
]

def call(method, path, body=None, extra=None, timeout=90):
    allowed = (
        '/rest/api/3/project/', '/rest/api/3/issuetype', '/rest/api/3/issuetypescheme/',
        '/rest/api/3/field', '/rest/api/3/workflowscheme/', '/rest/servicedeskapi/servicedesk/2183/',
        '/rest/servicedesk/1/servicedesk/12789/', '/forms/project/12789/'
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
    actual = field_kind(field)
    return actual == ('select' if wanted == 'checkbox' else wanted)

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
        candidates = [name, f'{name} - Ivanti', f'{name} - New Employee']
        selected = None
        for candidate in candidates:
            matches = [item for item in by_name.get(norm(candidate), []) if compatible(item, wanted)]
            if len(matches) == 1:
                selected = matches[0]
                break
        if selected is None:
            create_name = name if not by_name.get(norm(name)) else f'{name} - New Employee'
            custom_type, searcher = TYPE_DEF[wanted]
            status, selected = call('POST', '/rest/api/3/field', {
                'name': create_name,
                'description': source.get('description') or f'Migrated from Ivanti {SERVICE_NAME}.',
                'type': custom_type,
                'searcherKey': searcher,
            })
            require(status, selected, {200, 201}, f'field creation for {name}')
            by_name[norm(create_name)].append(selected)
            state = 'created'
        else:
            state = 'reused'
        field_id = str(selected.get('id') or '')
        if not field_id: raise RuntimeError(f'No Jira field ID for {name}')
        if wanted in {'select', 'checkbox'}:
            ensure_options(field_id, source.get('options') or (['Yes', 'No'] if wanted == 'checkbox' else []))
        resolved[name] = field_id
        results.append({'sourceName': name, 'jiraName': selected.get('name'), 'jiraFieldId': field_id, 'status': state})
    return resolved, results

def ensure_issue_and_request_type():
    status, types = call('GET', '/rest/api/3/issuetype')
    require(status, types, {200}, 'issue type inventory')
    matches = [item for item in types if norm(item.get('name')) == norm(SERVICE_NAME) and not item.get('subtask')]
    if len(matches) > 1: raise RuntimeError('Multiple New Employee Setup issue types exist; refusing ambiguous reuse')
    if matches:
        issue_type = matches[0]
        issue_state = 'reused'
    else:
        status, issue_type = call('POST', '/rest/api/3/issuetype', {
            'name': SERVICE_NAME,
            'description': 'Provisioning of new employee including equipment, accounts, and workspace setup.',
            'type': 'standard',
        })
        require(status, issue_type, {200, 201}, 'issue type creation')
        issue_state = 'created'
    issue_type_id = str(issue_type.get('id') or '')
    if not issue_type_id: raise RuntimeError('Jira did not return a New Employee issue type ID')

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
    if same and not exact: raise RuntimeError('New Employee request type exists against a different issue type')
    if exact:
        request_type = exact
        request_state = 'reused'
    else:
        status, request_type = call('POST', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype', {
            'name': SERVICE_NAME,
            'description': 'Provisioning of new employee including equipment, accounts, and workspace setup.',
            'helpText': 'Use this request to arrange accounts, equipment and workspace setup for a new employee.',
            'issueTypeId': issue_type_id,
        }, {'X-ExperimentalApi': 'opt-in'})
        require(status, request_type, {200, 201}, 'request type creation')
        request_state = 'created'
    request_type_id = str(request_type.get('id') or '')
    if not request_type_id: raise RuntimeError('Jira did not return a New Employee request type ID')
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
    if desired.get(issue_type_id) == STANDARD_WORKFLOW:
        return 'already-mapped'
    desired[issue_type_id] = STANDARD_WORKFLOW
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
    status, body = call('POST', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/draft/publish', {
        'statusMappings': [
            {'issueTypeId': issue_type_id, 'statusId': '1', 'newStatusId': '10121'},
            {'issueTypeId': issue_type_id, 'statusId': '4', 'newStatusId': '10121'},
        ]
    })
    require(status, body, {200, 204}, 'workflow publish')
    for _ in range(12):
        status, live = call('GET', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}')
        if status == 200 and (live.get('issueTypeMappings') or {}).get(issue_type_id) == STANDARD_WORKFLOW:
            return 'published'
        time.sleep(5)
    raise RuntimeError('New Employee workflow mapping did not persist')

def question_type(value):
    return {'paragraph': 'tl', 'date': 'da', 'select': 'cd', 'checkbox': 'cd', 'user': 'us'}.get(value, 'ts')

def heading(text):
    return {'type': 'heading', 'attrs': {'level': 2}, 'content': [{'type': 'text', 'text': text}]}

def question_extension(qid):
    return {'type': 'extension', 'attrs': {'extensionKey': 'question', 'extensionType': 'com.thinktilt.proforma', 'layout': 'default', 'localId': str(uuid.uuid4()), 'parameters': {'id': int(qid)}}}

def option_id(field_id, wanted):
    status, contexts = call('GET', f'/rest/api/3/field/{field_id}/context?startAt=0&maxResults=100')
    require(status, contexts, {200}, f'condition context for {field_id}')
    for context in contexts.get('values') or []:
        cid = str(context.get('id') or '')
        if not cid: continue
        status, options = call('GET', f'/rest/api/3/field/{field_id}/context/{cid}/option?startAt=0&maxResults=1000')
        require(status, options, {200}, f'condition options for {field_id}')
        match = next((x for x in options.get('values') or [] if norm(x.get('value')) == norm(wanted)), None)
        if match and match.get('id'): return str(match['id'])
    return None

def ensure_form(fields, request_type_id):
    questions = {}
    qid_by_name = {}
    for index, source in enumerate(FIELDS, 1):
        qid = str(index)
        qid_by_name[source['name']] = qid
        questions[qid] = {
            'label': source['name'], 'description': source.get('description') or '',
            'type': question_type(source['type']), 'jiraField': fields[source['name']],
            'questionKey': f'new-employee-{qid}', 'validation': {'rq': bool(source['required'])},
        }

    buckets = []
    for name in ['New Employee Information', 'Facility Detail', 'Equipment Details']:
        ids = [qid_by_name[x['name']] for x in FIELDS if x['section'] == name and not x.get('condition')]
        buckets.append({'name': name, 'qids': ids, 'condition': None})
    for source in FIELDS:
        if source.get('condition'):
            buckets.append({'name': f"{source['name']} — conditional", 'qids': [qid_by_name[source['name']]], 'condition': source['condition']})

    layout = []
    sections = {}
    for index, bucket in enumerate(buckets):
        layout.append({'version': 1, 'type': 'doc', 'content': [heading(bucket['name'])] + [question_extension(x) for x in bucket['qids']]})
        if index > 0: sections[str(index)] = {'name': bucket['name'], 'sectionType': 'p'}
    settings = {'language': 'en', 'name': FORM_NAME, 'primaryLocale': 'en-US', 'submit': {'lock': True, 'pdf': True}}
    design = {'conditions': {}, 'layout': layout, 'questions': questions, 'sections': sections, 'settings': settings}

    status, index = call('GET', f'/forms/project/{PROJECT_ID}/form')
    require(status, index, {200}, 'Forms index')
    existing = next((x for x in index if norm(x.get('name')) == norm(FORM_NAME)), None)
    form_id = str((existing or {}).get('id') or '')
    base_state = 'reused'
    if not form_id:
        status, created = call('POST', f'/forms/project/{PROJECT_ID}/form', {'design': {'conditions': {}, 'layout': [], 'questions': {}, 'sections': {}, 'settings': settings}})
        require(status, created, {200, 201}, 'Form creation')
        form_id = str(((created or {}).get('formTemplate') or {}).get('id') or (created or {}).get('id') or '')
        base_state = 'created'
    if not form_id: raise RuntimeError('Atlassian did not return a New Employee form ID')

    status, result = call('PUT', f'/forms/project/{PROJECT_ID}/form/{form_id}', {'design': design})
    require(status, result, {200, 201, 204}, 'Form population')
    status, stored = call('GET', f'/forms/project/{PROJECT_ID}/form/{form_id}')
    require(status, stored, {200}, 'Form population readback')
    stored_design = stored.get('design') or {}
    stored_questions = stored_design.get('questions') or {}
    stored_sections = stored_design.get('sections') or {}
    if len(stored_questions) != len(FIELDS):
        raise RuntimeError(f'Expected {len(FIELDS)} questions, persisted {len(stored_questions)}')

    conditions = {}
    for source in [x for x in FIELDS if x.get('condition')]:
        controller_name, wanted = source['condition']
        controller_field = fields[controller_name]
        persisted = next(((str(k), v) for k, v in stored_questions.items() if str(v.get('jiraField')) == controller_field), None)
        target_section = next(((str(k), v) for k, v in stored_sections.items() if norm(v.get('name')) == norm(f"{source['name']} — conditional")), None)
        token = option_id(controller_field, wanted)
        if not persisted or not target_section or not token:
            raise RuntimeError(f'Cannot build source condition for {source["name"]}')
        condition_id = str(len(conditions) + 1)
        conditions[condition_id] = {
            'i': {'co': {'cIds': {persisted[0]: [token]}}, 'operator': 'OR', 'groups': [{'operator': 'AND', 'checks': [{'fieldId': persisted[0], 'type': 'SOME_OF', 'constraint': [token]}]}]},
            'o': {'sIds': [target_section[0]], 't': 'sh'},
        }
    conditioned_sections = {}
    for section_id, section in stored_sections.items():
        value = dict(section)
        value['conditions'] = [cid for cid, condition in conditions.items() if str(section_id) in [str(x) for x in condition['o']['sIds']]]
        conditioned_sections[str(section_id)] = value
    active_design = dict(stored_design)
    active_design['sections'] = conditioned_sections
    active_design['conditions'] = conditions
    status, result = call('PUT', f'/forms/project/{PROJECT_ID}/form/{form_id}', {'design': active_design}, {'X-ExperimentalApi': 'opt-in'})
    require(status, result, {200, 201, 204}, 'Form condition persistence')

    publish = {
        'design': active_design,
        'publish': {
            'jira': {'issueCreateIssueTypeIds': [], 'issueCreateRequestTypeIds': [int(request_type_id)], 'recommendedIssueRequestTypeIds': [], 'submitOnCreate': True, 'validateOnCreate': True},
            'portal': {'portalRequestTypeIds': [int(request_type_id)], 'submitOnCreate': True, 'validateOnCreate': True},
        },
    }
    status, result = call('PUT', f'/forms/project/{PROJECT_ID}/form/{form_id}', publish)
    require(status, result, {200, 201, 204}, 'Form publication')
    status, final = call('GET', f'/forms/project/{PROJECT_ID}/form/{form_id}')
    require(status, final, {200}, 'Form final readback')
    final_design = final.get('design') or {}
    portal_ids = [str(x) for x in ((final.get('publish') or {}).get('portal') or {}).get('portalRequestTypeIds') or []]
    jira_ids = [str(x) for x in ((final.get('publish') or {}).get('jira') or {}).get('issueCreateRequestTypeIds') or []]
    if len(final_design.get('questions') or {}) != 26 or len(final_design.get('conditions') or {}) != 8:
        raise RuntimeError('Final Form readback count failed')
    if request_type_id not in portal_ids and request_type_id not in jira_ids:
        raise RuntimeError('New Employee Form is not attached to the request type')
    return form_id, base_state

def assign_portal_group(request_type_id):
    path = f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{COMMON_REQUESTS_GROUP_ID}/request-types/{request_type_id}'
    status, current = call('GET', path)
    require(status, current, {200}, 'portal group identity read')
    if str(current.get('id')) != request_type_id or int(current.get('projectId') or 0) != int(PROJECT_ID) or current.get('name') != SERVICE_NAME:
        raise RuntimeError('Portal group identity guard failed')
    payload = dict(current)
    payload['groups'] = [{'id': int(COMMON_REQUESTS_GROUP_ID), 'name': 'Common Requests'}]
    status, result = call('PUT', path, payload)
    require(status, result, {200}, 'portal group assignment')
    status, readback = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{request_type_id}')
    require(status, readback, {200}, 'portal group readback')
    if COMMON_REQUESTS_GROUP_ID not in [str(x) for x in readback.get('groupIds') or []]:
        raise RuntimeError('Common Requests group assignment did not persist')

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
        'sourceOffering': {'name': SERVICE_NAME, 'recId': 'F1901A6167B04E3EB2B7664675CCB528'},
        'issueType': {'id': issue_type_id, 'status': issue_state},
        'requestType': {'id': request_type_id, 'status': request_state, 'groupIds': request_type.get('groupIds')},
        'form': {'status': 'pending-forge-asApp', 'questions': 26, 'required': 13, 'sections': 3, 'persistedConditions': 8},
        'workflow': {'name': STANDARD_WORKFLOW, 'status': workflow_state},
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
