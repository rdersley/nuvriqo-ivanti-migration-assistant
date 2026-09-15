#!/usr/bin/env python3
"""Read-only completion inventory for the Ivanti -> Jira IT Help migration.

Every URL is checked by a hard allow-list. This script cannot address SD and cannot
write to Jira: it only issues GET requests for IT project 12789 / service desk 2183.
"""
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SITE = os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
EMAIL = os.environ['FORGE_EMAIL']
TOKEN = os.environ['FORGE_API_TOKEN']
PROJECT_ID = '12789'
PROJECT_KEY = 'IT'
SERVICE_DESK_ID = '2183'
OUT = Path('migration-output/it-completion-inventory')
OUT.mkdir(parents=True, exist_ok=True)

REQUEST_TYPES = {
    'AWS Account management': '2424',
    'Bitbucket Cloud Support': '2425',
    'Domain Password Reset': '2426',
    'Employee Move': '2427',
    'Leaver': '2428',
    'New Application Access Request': '2429',
    'New IT Software Request': '2430',
    'New Service Request': '2431',
    'New Vector System Provisioning': '2432',
    'Production Vector System Decommissioning': '2433',
    'Suspend Temporary Access': '2434',
    'Test Vector System Decommissioning': '2435',
    'UAT Vector System Decommissioning': '2436',
    'cBase Leaver': '2437',
}

AUTH = base64.b64encode(f'{EMAIL}:{TOKEN}'.encode()).decode()
HEADERS = {'Authorization': f'Basic {AUTH}', 'Accept': 'application/json'}

def assert_safe(path: str) -> None:
    decoded = urllib.parse.unquote(path).lower()
    forbidden = ['/project/sd', 'projectkey=sd', 'project = sd', '/servicedeskapi/servicedesk/sd']
    if any(value in decoded for value in forbidden):
        raise SystemExit(f'Forbidden SD target in read-only inventory path: {path}')
    allowed = (
        '/rest/api/3/project/it', f'/rest/api/3/project/{PROJECT_ID}',
        f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}',
        f'/forms/project/{PROJECT_ID}', '/rest/api/3/field',
        '/rest/api/3/workflow', '/rest/api/3/workflowscheme',
        '/rest/api/3/status', '/rest/api/3/search', '/rest/api/3/group',
    )
    if not path.startswith(allowed):
        raise SystemExit(f'Path is outside the IT completion inventory allow-list: {path}')

def get(path: str):
    assert_safe(path)
    request = urllib.request.Request(SITE + path, headers=HEADERS, method='GET')
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode('utf-8', 'replace')
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode('utf-8', 'replace')
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = raw
        return error.code, body

def paged(path: str, value_key='values', start_name='startAt', size_name='maxResults', size=100):
    values = []
    start = 0
    pages = []
    for _ in range(100):
        separator = '&' if '?' in path else '?'
        status, body = get(f'{path}{separator}{start_name}={start}&{size_name}={size}')
        pages.append({'status': status, 'start': start})
        if status != 200 or not isinstance(body, dict):
            return {'status': status, 'values': values, 'pages': pages, 'error': body}
        batch = body.get(value_key) or []
        values.extend(batch)
        if body.get('isLast') is True or not batch:
            break
        start += len(batch)
        if start >= int(body.get('total') or body.get('size') or 10**9):
            break
    return {'status': 200, 'values': values, 'pages': pages}

project_status, project = get('/rest/api/3/project/IT')
if project_status != 200 or str((project or {}).get('id')) != PROJECT_ID or str((project or {}).get('key')) != PROJECT_KEY:
    raise SystemExit(f'Hard IT target guard failed: HTTP {project_status} {project}')

request_type_page = paged(f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?includeHiddenRequestTypesInSearch=true', size_name='limit')
request_types = request_type_page['values']
for name, request_type_id in REQUEST_TYPES.items():
    if not any(str(item.get('id')) == request_type_id and item.get('name') == name for item in request_types):
        raise SystemExit(f'IT request type guard failed for {name} ({request_type_id})')

fields_status, fields = get('/rest/api/3/field')
if fields_status != 200 or not isinstance(fields, list):
    raise SystemExit(f'Field inventory failed: HTTP {fields_status}')
approval_fields = [
    {'id': item.get('id'), 'name': item.get('name'), 'schema': item.get('schema')}
    for item in fields
    if re.search(r'approv', str(item.get('name') or ''), re.I)
]

forms_status, form_index = get(f'/forms/project/{PROJECT_ID}/form')
forms = []
if forms_status == 200 and isinstance(form_index, list):
    for summary in form_index:
        name = str(summary.get('name') or '')
        if not name.endswith(' - Ivanti Migration Form'):
            continue
        form_id = str(summary.get('id') or '')
        status, detail = get(f'/forms/project/{PROJECT_ID}/form/{form_id}')
        design = (detail or {}).get('design') or {} if isinstance(detail, dict) else {}
        publish = (detail or {}).get('publish') or {} if isinstance(detail, dict) else {}
        forms.append({
            'id': form_id, 'name': name, 'http': status,
            'questionCount': len(design.get('questions') or {}),
            'sectionCount': len(design.get('sections') or {}),
            'conditionCount': len(design.get('conditions') or {}),
            'design': design, 'publish': publish,
        })

roles_status, roles = get(f'/rest/api/3/project/{PROJECT_ID}/role')
role_details = []
if roles_status == 200 and isinstance(roles, dict):
    for role_name, role_url in roles.items():
        match = re.search(r'/role/(\d+)$', str(role_url))
        if not match:
            continue
        status, detail = get(f'/rest/api/3/project/{PROJECT_ID}/role/{match.group(1)}')
        role_details.append({'name': role_name, 'id': match.group(1), 'http': status, 'actors': (detail or {}).get('actors', []) if isinstance(detail, dict) else []})

checks = {}
for key, path in {
    'projectStatuses': f'/rest/api/3/project/{PROJECT_ID}/statuses',
    'workflowScheme': f'/rest/api/3/workflowscheme/project?projectId={PROJECT_ID}',
    'workflows': f'/rest/api/3/workflow/search?projectId={PROJECT_ID}&maxResults=100',
    'queues': f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/queue?start=0&limit=100&includeCount=true',
    'requestTypeGroups': f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttypegroup',
}.items():
    status, body = get(path)
    checks[key] = {'http': status, 'body': body}

issue_counts = {}
for name in REQUEST_TYPES:
    jql = urllib.parse.quote(f'project = IT AND issuetype = "{name}"', safe='')
    status, body = get(f'/rest/api/3/search/jql?jql={jql}&maxResults=1&fields=key,status,requesttype')
    issue_counts[name] = {'http': status, 'total': (body or {}).get('total') if isinstance(body, dict) else None, 'issues': (body or {}).get('issues', []) if isinstance(body, dict) else []}

report = {
    'mode': 'READ_ONLY_IT_COMPLETION_INVENTORY',
    'target': {'projectKey': PROJECT_KEY, 'projectId': PROJECT_ID, 'serviceDeskId': SERVICE_DESK_ID},
    'project': project,
    'requestTypes': request_types,
    'approvalFields': approval_fields,
    'forms': forms,
    'projectRoles': role_details,
    'checks': checks,
    'issueCounts': issue_counts,
}
(OUT / 'inventory.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
summary = {
    'project': {'id': project.get('id'), 'key': project.get('key'), 'name': project.get('name')},
    'requestTypesVerified': sum(1 for name, rid in REQUEST_TYPES.items() if any(str(item.get('id')) == rid and item.get('name') == name for item in request_types)),
    'formsFound': len(forms),
    'formsWithConditions': sum(1 for item in forms if item['conditionCount'] > 0),
    'approvalFields': len(approval_fields),
    'projectRoles': len(role_details),
    'readOnly': True,
}
print(json.dumps(summary, indent=2))
if summary['requestTypesVerified'] != 14 or summary['formsFound'] != 14:
    raise SystemExit('Completion inventory failed the 14-request-type/form guard')
