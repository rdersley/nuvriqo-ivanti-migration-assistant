#!/usr/bin/env python3
"""Guarded, idempotent release of the remaining Ivanti offerings into IT Help only.

Reads src/ivanti-offerings.json and, per offering, creates or reuses the issue
type, request type, portal group and Jira fields, then maps every new issue type
to the standard or approval workflow in a single workflow-scheme publish. The
Forms are built afterwards by the Forge ivanti-offerings-release webtrigger.
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
STANDARD_WORKFLOW = 'IT: Service Request Fulfilment workflow for Jira Service Management'
APPROVAL_WORKFLOW = 'IT: Service Request Fulfilment with Approvals workflow for Jira Service Management'
PORTAL_GROUPS = {'2256': 'Common Requests', '2257': 'Computers', '2258': 'Logins and Accounts', '2259': 'Applications', '2260': 'Servers and Infrastructure'}
SPEC = json.loads(Path('src/ivanti-offerings.json').read_text(encoding='utf-8'))
OUT = Path('migration-output/ivanti-offerings-release')
OUT.mkdir(parents=True, exist_ok=True)

TYPE_DEF = {
    'text': ('com.atlassian.jira.plugin.system.customfieldtypes:textfield', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
    'paragraph': ('com.atlassian.jira.plugin.system.customfieldtypes:textarea', 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher'),
    'date': ('com.atlassian.jira.plugin.system.customfieldtypes:datepicker', 'com.atlassian.jira.plugin.system.customfieldtypes:daterange'),
    'datetime': ('com.atlassian.jira.plugin.system.customfieldtypes:datetime', 'com.atlassian.jira.plugin.system.customfieldtypes:datetimerange'),
    'number': ('com.atlassian.jira.plugin.system.customfieldtypes:float', 'com.atlassian.jira.plugin.system.customfieldtypes:exactnumber'),
    'select': ('com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
    'checkbox': ('com.atlassian.jira.plugin.system.customfieldtypes:select', 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher'),
    'user': ('com.atlassian.jira.plugin.system.customfieldtypes:userpicker', 'com.atlassian.jira.plugin.system.customfieldtypes:userpickergroupsearcher'),
}

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

def questions(offering):
    for section in offering['sections']:
        for question in section['questions']:
            yield question

def jira_field_names(offering):
    """Deterministic Jira field name per question key. Mirrors fieldNames() in src/ivantiOfferingsWebtrigger.ts."""
    seen = defaultdict(int)
    names = {}
    for question in questions(offering):
        if question['type'] == 'attachment':
            continue
        seen[norm(question['label'])] += 1
        count = seen[norm(question['label'])]
        names[question['key']] = f"{question['label']} - {offering['short']}" + (f' ({count})' if count > 1 else '')
    return names

def options_for(question):
    if question['type'] == 'checkbox': return ['Yes', 'No']
    if question.get('optionsRef'): return SPEC['lists'][question['optionsRef']]
    return question.get('options') or []

def field_kind(field):
    custom = str((field.get('schema') or {}).get('custom') or '')
    if 'textarea' in custom: return 'paragraph'
    if 'textfield' in custom: return 'text'
    if 'datepicker' in custom: return 'date'
    if custom.endswith(':datetime'): return 'datetime'
    if custom.endswith(':float'): return 'number'
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

def ensure_fields(offering, by_name):
    results = []
    names = jira_field_names(offering)
    for question in questions(offering):
        if question['type'] == 'attachment':
            continue
        wanted, jira_name = question['type'], names[question['key']]
        same = by_name.get(norm(jira_name), [])
        matches = [item for item in same if compatible(item, wanted)]
        if len(matches) > 1: raise RuntimeError(f'Multiple {jira_name} fields exist; refusing ambiguous reuse')
        if same and not matches: raise RuntimeError(f'{jira_name} exists with an incompatible type')
        if matches:
            selected, state = matches[0], 'reused'
        else:
            custom_type, searcher = TYPE_DEF[wanted]
            status, selected = call('POST', '/rest/api/3/field', {
                'name': jira_name,
                'description': question.get('desc') or f"Migrated from Ivanti {offering['name']}.",
                'type': custom_type,
                'searcherKey': searcher,
            })
            require(status, selected, {200, 201}, f'field creation for {jira_name}')
            by_name[norm(jira_name)].append(selected)
            state = 'created'
        field_id = str(selected.get('id') or '')
        if not field_id: raise RuntimeError(f'No Jira field ID for {jira_name}')
        if wanted in {'select', 'checkbox'}:
            ensure_options(field_id, options_for(question))
        results.append({'jiraName': jira_name, 'jiraFieldId': field_id, 'status': state})
    return results

def issue_type_scheme():
    status, association = call('GET', f'/rest/api/3/issuetypescheme/project?projectId={PROJECT_ID}')
    require(status, association, {200}, 'issue type scheme association')
    row = next((x for x in association.get('values') or [] if PROJECT_ID in [str(v) for v in x.get('projectIds') or []]), None)
    scheme_id = str(((row or {}).get('issueTypeScheme') or {}).get('id') or '')
    if not scheme_id: raise RuntimeError('Could not resolve the IT issue type scheme')
    return scheme_id

def ensure_issue_and_request_type(offering, types, scheme_id, requests):
    name = offering['name']
    matches = [item for item in types if norm(item.get('name')) == norm(name) and not item.get('subtask')]
    if len(matches) > 1: raise RuntimeError(f'Multiple {name} issue types exist; refusing ambiguous reuse')
    if matches:
        issue_type, issue_state = matches[0], 'reused'
    else:
        status, issue_type = call('POST', '/rest/api/3/issuetype', {'name': name, 'description': offering['description'][:250], 'type': 'standard'})
        require(status, issue_type, {200, 201}, f'issue type creation for {name}')
        types.append(issue_type)
        issue_state = 'created'
    issue_type_id = str(issue_type.get('id') or '')
    if not issue_type_id: raise RuntimeError(f'Jira did not return a {name} issue type ID')

    status, mappings = call('GET', f'/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId={scheme_id}&maxResults=500')
    require(status, mappings, {200}, 'issue type scheme mapping')
    if issue_type_id not in {str(v.get('issueTypeId')) for v in mappings.get('values') or []}:
        status, body = call('PUT', f'/rest/api/3/issuetypescheme/{scheme_id}/issuetype', {'issueTypeIds': [issue_type_id]})
        require(status, body, {200, 204}, f'IT issue type association for {name}')

    same = [item for item in requests if norm(item.get('name')) == norm(name)]
    exact = next((item for item in same if str(item.get('issueTypeId')) == issue_type_id), None)
    if same and not exact: raise RuntimeError(f'{name} request type exists against a different issue type')
    if exact:
        request_type, request_state = exact, 'reused'
    else:
        status, request_type = call('POST', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype', {
            'name': name,
            'description': f'Migrated from Ivanti: {name}',
            'helpText': offering['description'],
            'issueTypeId': issue_type_id,
        }, {'X-ExperimentalApi': 'opt-in'})
        require(status, request_type, {200, 201}, f'request type creation for {name}')
        requests.append(request_type)
        request_state = 'created'
    request_type_id = str(request_type.get('id') or '')
    if not request_type_id: raise RuntimeError(f'Jira did not return a {name} request type ID')
    return issue_type_id, request_type_id, issue_state, request_state

def assign_portal_group(offering, request_type_id):
    group_id = offering['group']
    path = f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups/{group_id}/request-types/{request_type_id}'
    status, current = call('GET', path)
    require(status, current, {200}, 'portal group identity read')
    if str(current.get('id')) != request_type_id or int(current.get('projectId') or 0) != int(PROJECT_ID) or current.get('name') != offering['name']:
        raise RuntimeError('Portal group identity guard failed')
    payload = dict(current)
    payload['groups'] = [{'id': int(group_id), 'name': PORTAL_GROUPS[group_id]}]
    status, result = call('PUT', path, payload)
    require(status, result, {200}, 'portal group assignment')
    status, readback = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype/{request_type_id}')
    require(status, readback, {200}, 'portal group readback')
    if group_id not in [str(x) for x in readback.get('groupIds') or []]:
        raise RuntimeError(f'{PORTAL_GROUPS[group_id]} group assignment did not persist')

def map_workflows(wanted):
    """wanted: {issueTypeId: workflowName}. One draft publish for every missing mapping."""
    status, result = call('GET', f'/rest/api/3/workflowscheme/project?projectId={PROJECT_ID}')
    require(status, result, {200}, 'workflow scheme association')
    row = next((x for x in result.get('values') or [] if PROJECT_ID in [str(v) for v in x.get('projectIds') or []]), None)
    scheme = (row or {}).get('workflowScheme') or {}
    if str(scheme.get('id')) != WORKFLOW_SCHEME_ID:
        raise RuntimeError(f'IT workflow scheme guard failed: {scheme.get("id")}')
    if any(str(v) != PROJECT_ID for v in (row or {}).get('projectIds') or []):
        raise RuntimeError('IT workflow scheme is shared; refusing workflow update')
    desired = dict(scheme.get('issueTypeMappings') or {})
    missing = {k: v for k, v in wanted.items() if desired.get(k) != v}
    if not missing:
        return 'already-mapped'
    desired.update(missing)
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
    # New issue types start on the scheme default workflow (Open/Reopened);
    # both map to Waiting for Support, as for the other migrated types.
    mappings = []
    for issue_type_id in missing:
        mappings += [{'issueTypeId': issue_type_id, 'statusId': '1', 'newStatusId': '10121'},
                     {'issueTypeId': issue_type_id, 'statusId': '4', 'newStatusId': '10121'}]
    status, body = call('POST', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}/draft/publish', {'statusMappings': mappings})
    require(status, body, {200, 204}, 'workflow publish')
    for _ in range(24):
        status, live = call('GET', f'/rest/api/3/workflowscheme/{WORKFLOW_SCHEME_ID}')
        live_map = (live.get('issueTypeMappings') or {}) if status == 200 else {}
        if all(live_map.get(k) == v for k, v in missing.items()):
            return 'published'
        time.sleep(5)
    raise RuntimeError('Workflow mappings did not persist')

def main():
    if SITE_HOST.lower() != 'retailinmotion.atlassian.net':
        raise RuntimeError('Site guard failed')
    status, project = call('GET', f'/rest/api/3/project/{PROJECT_KEY}')
    require(status, project, {200}, 'IT project guard')
    if str(project.get('id')) != PROJECT_ID or project.get('key') != PROJECT_KEY:
        raise RuntimeError('IT project identity guard failed')

    status, types = call('GET', '/rest/api/3/issuetype')
    require(status, types, {200}, 'issue type inventory')
    status, listing = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
    require(status, listing, {200}, 'request type inventory')
    requests = listing.get('values') or []
    scheme_id = issue_type_scheme()
    by_name = defaultdict(list)
    for item in all_fields(): by_name[norm(item.get('name'))].append(item)

    results, wanted = [], {}
    for offering in SPEC['offerings']:
        entry = {'name': offering['name']}
        try:
            issue_type_id, request_type_id, issue_state, request_state = ensure_issue_and_request_type(offering, types, scheme_id, requests)
            entry.update({'issueTypeId': issue_type_id, 'requestTypeId': request_type_id, 'issueType': issue_state, 'requestType': request_state})
            wanted[issue_type_id] = APPROVAL_WORKFLOW if offering['approval'] else STANDARD_WORKFLOW
            if offering.get('group'):
                assign_portal_group(offering, request_type_id)
            fields = ensure_fields(offering, by_name)
            entry.update({'group': PORTAL_GROUPS[offering['group']] if offering.get('group') else 'unchanged', 'workflow': wanted[issue_type_id], 'fieldsCreated': sum(f['status'] == 'created' for f in fields), 'fieldsReused': sum(f['status'] == 'reused' for f in fields), 'ok': True})
        except Exception as error:
            entry.update({'ok': False, 'error': str(error)})
        results.append(entry)
        print(json.dumps(entry))

    workflow_state = map_workflows(wanted) if wanted else 'nothing-to-map'
    report = {
        'ok': all(r['ok'] for r in results),
        'target': {'projectKey': PROJECT_KEY, 'projectId': PROJECT_ID, 'serviceDeskId': SERVICE_DESK_ID, 'workflowSchemeId': WORKFLOW_SCHEME_ID},
        'workflowPublish': workflow_state,
        'offerings': results,
        'qaTicketsCreated': 0,
    }
    (OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'ok': report['ok'], 'workflowPublish': workflow_state, 'failed': [r['name'] for r in results if not r['ok']]}, indent=2))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        report = {'ok': False, 'error': str(error), 'target': {'projectKey': PROJECT_KEY, 'projectId': PROJECT_ID, 'serviceDeskId': SERVICE_DESK_ID}}
        (OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
        sys.exit(2)
