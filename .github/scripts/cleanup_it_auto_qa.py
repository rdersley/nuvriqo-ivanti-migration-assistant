#!/usr/bin/env python3
"""Delete only migration AUTO-QA parents (and their subtasks) from IT project 12789."""
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
LABEL = 'ivanti-migration-auto-qa'
PREFIX = '[AUTO-QA] Ivanti migration completion'
OUT = Path('migration-output/it-auto-qa-cleanup')
OUT.mkdir(parents=True, exist_ok=True)

def call(method, path, body=None):
    value = urllib.parse.unquote(path).lower()
    allowed = ('/rest/api/3/project/it', '/rest/api/3/search/jql', '/rest/api/3/issue/')
    if not value.startswith(allowed):
        raise RuntimeError(f'Path outside cleanup allow-list: {method} {path}')
    if method not in ('GET', 'DELETE'):
        raise RuntimeError(f'Cleanup method refused: {method}')
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(SITE + path, headers=HEAD, method=method, data=data)
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            raw = response.read().decode('utf-8', 'replace')
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode('utf-8', 'replace')
        try: parsed = json.loads(raw) if raw else {}
        except Exception: parsed = raw
        return error.code, parsed

status, project = call('GET', '/rest/api/3/project/IT')
if status != 200 or str(project.get('id')) != PROJECT_ID:
    raise SystemExit('Hard IT project guard failed')

jql = urllib.parse.quote(f'project = {PROJECT_KEY} AND labels = {LABEL} ORDER BY created DESC')
deleted = []
refused = []
for _ in range(20):
    status, page = call('GET', f'/rest/api/3/search/jql?jql={jql}&maxResults=100&fields=summary,project,labels')
    if status != 200:
        raise RuntimeError(f'Cleanup search failed: HTTP {status} {page}')
    issues = page.get('issues') or []
    if not issues:
        break
    for issue in issues:
        key = str(issue.get('key') or '')
        fields = issue.get('fields') or {}
        summary = str(fields.get('summary') or '')
        labels = fields.get('labels') or []
        project_id = str((fields.get('project') or {}).get('id') or '')
        if project_id != PROJECT_ID or LABEL not in labels or not summary.startswith(PREFIX):
            refused.append({'key': key, 'summary': summary, 'projectId': project_id, 'labels': labels})
            continue
        delete_status, delete_body = call('DELETE', f'/rest/api/3/issue/{key}?deleteSubtasks=true')
        if delete_status not in (204, 404):
            raise RuntimeError(f'Failed deleting {key}: HTTP {delete_status} {delete_body}')
        deleted.append(key)
    if refused:
        break
    time.sleep(2)
else:
    raise RuntimeError('Cleanup exceeded bounded search passes')

status, remaining = call('GET', f'/rest/api/3/search/jql?jql={jql}&maxResults=1&fields=summary,project,labels')
remaining_count = len(remaining.get('issues') or []) if status == 200 else -1
report = {'target': {'projectKey': PROJECT_KEY, 'projectId': PROJECT_ID}, 'label': LABEL,
          'deletedParents': deleted, 'deletedParentCount': len(deleted), 'refused': refused,
          'remainingAutoQaParents': remaining_count}
(OUT / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2))
if refused or remaining_count != 0:
    raise SystemExit(2)
