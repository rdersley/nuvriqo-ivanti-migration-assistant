#!/usr/bin/env python3
"""Live end-to-end verification for all 14 migrated IT Help request types.

The script creates only labelled AUTO-QA issues in project 12789 and deletes those
same issues after verification. It never addresses SD or any other service desk.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SITE_HOST = os.environ['RIM_FORGE_SITE'].strip().rstrip('/')
SITE = SITE_HOST if SITE_HOST.startswith(('http://', 'https://')) else f'https://{SITE_HOST}'
AUTH = base64.b64encode(f"{os.environ['FORGE_EMAIL']}:{os.environ['FORGE_API_TOKEN']}".encode()).decode()
HEAD = {'Authorization': f'Basic {AUTH}', 'Accept': 'application/json', 'Content-Type': 'application/json'}
PROJECT_ID = '12789'
PROJECT_KEY = 'IT'
SERVICE_DESK_ID = '2183'
AUTO_PREFIX = '[AUTO-QA] Ivanti migration completion'
OUT = Path('migration-output/it-end-to-end')
OUT.mkdir(parents=True, exist_ok=True)
PLAN = json.loads(Path('migration-evidence/source-backed-completion-plan.json').read_text())
MIGRATION = json.loads(Path('migration-output/it-webtrigger/response.json').read_text())
SOURCE_PAYLOAD = json.loads(Path('migration-output/it-webtrigger/payload.json').read_text())

def safe(path, method):
    value = urllib.parse.unquote(path).lower()
    if '/project/sd' in value or 'project = sd' in value or '/servicedeskapi/servicedesk/sd' in value:
        raise RuntimeError(f'Forbidden SD target: {method} {path}')
    allowed = ('/rest/api/3/project/it', '/rest/api/3/project/12789', '/rest/api/3/issue',
               '/rest/api/3/search', '/rest/api/3/field', '/rest/api/3/workflowscheme/project',
               '/rest/api/3/workflowscheme/12635',
               '/rest/servicedeskapi/servicedesk/2183')
    if not value.startswith(allowed):
        raise RuntimeError(f'Path outside IT E2E allow-list: {method} {path}')
    if method != 'GET' and not value.startswith('/rest/api/3/issue'):
        raise RuntimeError(f'Only AUTO-QA issue writes are allowed: {method} {path}')

def call(method, path, body=None):
    safe(path, method)
    data = None if body is None else json.dumps(body).encode()
    for attempt in range(3):
        request = urllib.request.Request(SITE + path, headers=HEAD, method=method, data=data)
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read().decode('utf-8', 'replace')
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read().decode('utf-8', 'replace')
            try: error_body = json.loads(raw) if raw else {}
            except Exception: error_body = raw
            return error.code, error_body
        except (urllib.error.URLError, ConnectionResetError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))

def require(ok, message):
    if not ok: raise RuntimeError(message)

def transition_done(issue_key):
    status, body = call('GET', f'/rest/api/3/issue/{issue_key}/transitions')
    require(status == 200, f'cannot read transitions for {issue_key}: HTTP {status}')
    transitions = body.get('transitions') or []
    chosen = next((item for item in transitions if str(item.get('to',{}).get('statusCategory',{}).get('key')) == 'done'), None)
    require(chosen and chosen.get('id'), f'no Done-category transition for {issue_key}')
    apply_status, apply_body = call('POST', f'/rest/api/3/issue/{issue_key}/transitions', {'transition': {'id': str(chosen['id'])}})
    require(apply_status == 204, f'cannot complete {issue_key}: HTTP {apply_status} {apply_body}')

project_status, project = call('GET', '/rest/api/3/project/IT')
require(project_status == 200 and str(project.get('id')) == PROJECT_ID, 'Hard IT project guard failed')
rt_status, rt_body = call('GET', f'/rest/servicedeskapi/servicedesk/{SERVICE_DESK_ID}/requesttype?start=0&limit=100&includeHiddenRequestTypesInSearch=true')
require(rt_status == 200, f'Cannot read IT request types: {rt_status}')
request_types = rt_body.get('values') or []
status_code, project_statuses = call('GET', f'/rest/api/3/project/{PROJECT_ID}/statuses')
require(status_code == 200, f'Cannot read IT workflow statuses: {status_code}')
status_by_type = {str(item.get('id')): {str(status.get('name')) for status in item.get('statuses') or []} for item in project_statuses}
scheme_id = str(PLAN['target']['workflowSchemeId'])
scheme_status, scheme = call('GET', f'/rest/api/3/workflowscheme/{scheme_id}')
require(scheme_status == 200 and str(scheme.get('id')) == scheme_id, 'IT workflow scheme guard failed')
form_results = {item.get('service'): item for item in MIGRATION.get('results') or []}

results = []
created_keys = []
try:
    for service in PLAN['services']:
        print(f"E2E start: {service['name']}", flush=True)
        row = {'service': service['name'], 'requestTypeId': service['requestTypeId'], 'issueTypeId': service['issueTypeId'], 'checks': []}
        try:
            rt = next((item for item in request_types if str(item.get('id')) == service['requestTypeId'] and item.get('name') == service['name']), None)
            require(rt and str(rt.get('issueTypeId')) == service['issueTypeId'], 'request type/issue type readback mismatch')
            row['checks'].append('request-type')
            form = form_results.get(service['name'])
            require(form and form.get('status') == 'published', 'published Forms readback missing')
            row['checks'].append('form-published')
            source_service = next(item for item in SOURCE_PAYLOAD['services'] if item['name'] == service['name'])
            expected_conditions = sum(bool(str(field.get('visibilityExpression') or '').strip()) for field in source_service.get('fields') or [])
            require(int(form.get('conditions') or 0) == expected_conditions, 'condition readback mismatch')
            row['checks'].append(f'conditions:{expected_conditions}')
            expected_workflow = PLAN['workflows']['approval' if service['approval'] else 'standard']
            require((scheme.get('issueTypeMappings') or {}).get(service['issueTypeId']) == expected_workflow, 'workflow mapping mismatch')
            statuses = status_by_type.get(service['issueTypeId']) or set()
            require({'Waiting for customer', 'Canceled', 'In Progress', 'Resolved', 'Closed'}.issubset(statuses), f'fulfilment lifecycle missing: {sorted(statuses)}')
            if service['approval']:
                require('Waiting for approval' in statuses, 'approval status missing')
            row['checks'].append('approval-workflow' if service['approval'] else 'standard-workflow')

            create_status, created = call('POST', '/rest/api/3/issue', {'fields': {
                'project': {'id': PROJECT_ID}, 'issuetype': {'id': service['issueTypeId']},
                'summary': f"{AUTO_PREFIX} — {service['name']} — {int(time.time())}",
                'description': {'type':'doc','version':1,'content':[{'type':'paragraph','content':[{'type':'text','text':'Automated end-to-end validation. Safe to delete.'}]}]},
                'labels': ['ivanti-migration-auto-qa']
            }})
            require(create_status == 201 and created.get('key'), f'create failed: HTTP {create_status} {created}')
            key = str(created['key']); created_keys.append(key); row['issueKey'] = key
            read_status, issue = call('GET', f'/rest/api/3/issue/{key}?fields=project,issuetype,summary,status,subtasks,labels')
            require(read_status == 200 and str(issue.get('fields',{}).get('project',{}).get('id')) == PROJECT_ID, 'created issue target readback failed')
            row['checks'].append('issue-create-readback')

            expected_tasks = service.get('tasks') or []
            if expected_tasks:
                observed_by_key = {}
                completed_children = set()
                reconciliation_nudge_count = 0
                deadline = time.time() + 600
                parent_done = False
                while time.time() < deadline and not parent_done:
                    _, parent = call('GET', f'/rest/api/3/issue/{key}?fields=subtasks')
                    refs = parent.get('fields',{}).get('subtasks') or []
                    for ref in refs:
                        _, child = call('GET', f"/rest/api/3/issue/{ref['key']}?fields=summary,description,labels,parent")
                        if 'ivanti-orchestration' in (child.get('fields',{}).get('labels') or []):
                            child_key = str(child.get('key') or ref['key'])
                            observed_by_key[child_key] = {
                                'summary': str(child.get('fields',{}).get('summary') or ''),
                                'description': json.dumps(child.get('fields',{}).get('description') or {})
                            }
                    for child_key in sorted(set(observed_by_key) - completed_children):
                        transition_done(child_key)
                        completed_children.add(child_key)
                    if completed_children:
                        reconcile_label = f'ivanti-orchestration-reconcile-{reconciliation_nudge_count % 2}'
                        nudge_status, nudge_body = call('PUT', f'/rest/api/3/issue/{key}', {'fields': {
                            'labels': ['ivanti-migration-auto-qa', reconcile_label]
                        }})
                        require(nudge_status == 204, f'parent reconciliation nudge failed: HTTP {nudge_status} {nudge_body}')
                        reconciliation_nudge_count += 1
                    _, parent_status = call('GET', f'/rest/api/3/issue/{key}?fields=status')
                    parent_done = str(parent_status.get('fields',{}).get('status',{}).get('statusCategory',{}).get('key')) == 'done'
                    if parent_done and sorted(item['summary'] for item in observed_by_key.values()) == sorted(expected_tasks): break
                    time.sleep(5)
                observed = [item['summary'] for item in observed_by_key.values()]
                require(sorted(observed) == sorted(expected_tasks), f'orchestration mismatch expected={expected_tasks} observed={observed}')
                row['checks'].append(f'orchestration:{len(expected_tasks)}')
                task_routes = service.get('taskRoutes') or {}
                for child_key, child in observed_by_key.items():
                    expected_team = str(task_routes.get(child['summary']) or service.get('routingTeam') or '').strip()
                    require(expected_team, f'source routing team missing from plan for {child["summary"]}')
                    description = child['description']
                    require(f'Ivanti assignment team: {expected_team}' in description, f'source routing metadata missing on {child_key}')
                row['checks'].append('routing-metadata')
                require(parent_done, 'parent did not complete after all source-backed child tasks completed')
                row['checks'].append('orchestration-completion')
            row['status'] = 'passed'
        except Exception as error:
            row['status'] = 'failed'; row['error'] = str(error)
        results.append(row)
        print(f"E2E result: {service['name']} — {row['status']} {row.get('error','')}", flush=True)
finally:
    cleanup = []
    for key in reversed(created_keys):
        read_status, issue = call('GET', f'/rest/api/3/issue/{key}?fields=summary')
        summary = str(issue.get('fields',{}).get('summary') or '') if read_status == 200 else ''
        if not summary.startswith(AUTO_PREFIX):
            cleanup.append({'key': key, 'status': 'refused-non-auto-qa'})
            continue
        delete_status, _ = call('DELETE', f'/rest/api/3/issue/{key}?deleteSubtasks=true')
        cleanup.append({'key': key, 'status': 'deleted' if delete_status in (204,404) else f'failed-http-{delete_status}'})

report = {'mode':'LIVE_IT_END_TO_END','target':PLAN['target'],'verified':sum(item['status']=='passed' for item in results),'failed':sum(item['status']=='failed' for item in results),'results':results,'cleanup':cleanup}
(OUT/'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'verified':report['verified'],'failed':report['failed'],'cleanup':cleanup}, indent=2))
for item in results: print(f"{item['service']}: {item['status']} {'; '.join(item.get('checks') or [])} {item.get('error','')}")
if report['verified'] != 14 or report['failed']:
    raise SystemExit(2)
