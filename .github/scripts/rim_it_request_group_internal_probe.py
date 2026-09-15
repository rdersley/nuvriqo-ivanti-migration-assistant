#!/usr/bin/env python3
import base64, json, os, urllib.request, urllib.error
from pathlib import Path

SITE = 'https://retailinmotion.atlassian.net'
PROJECT_KEY = 'IT'
PROJECT_ID = '12789'
SERVICE_DESK_ID = '2183'
OUT = Path('migration-output/it-request-type-groups/internal-probe.json')
OUT.parent.mkdir(parents=True, exist_ok=True)

email = os.environ.get('FORGE_EMAIL','').strip()
token = os.environ.get('FORGE_API_TOKEN','').strip()
if not email or not token:
    raise SystemExit('Missing FORGE_EMAIL/FORGE_API_TOKEN')
auth = base64.b64encode(f'{email}:{token}'.encode()).decode()
headers = {'Authorization': f'Basic {auth}', 'Accept': 'application/json', 'Content-Type': 'application/json'}

# Read-only probes for the Agent-view endpoints Atlassian uses for request-type grouping.
# Previous live response proved this endpoint expects the Jira project ID, not key/service-desk ID.
# No mutations are made here. Target remains hard-coded to IT project 12789 / service desk 2183.
paths = [
    f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups',
    f'/rest/servicedesk/1/servicedesk/{PROJECT_ID}/request-type-groups?expand=requestTypes',
]

def get(path):
    req = urllib.request.Request(SITE + path, headers=headers, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode('utf-8','replace')
            try: body = json.loads(raw)
            except Exception: body = raw
            return {'path': path, 'status': r.status, 'body': body}
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8','replace')
        try: body = json.loads(raw)
        except Exception: body = raw[:4000]
        return {'path': path, 'status': e.code, 'body': body}

results = [get(p) for p in paths]
OUT.write_text(json.dumps({'mode':'READ_ONLY_INTERNAL_GROUP_PROBE','projectKey':PROJECT_KEY,'projectId':PROJECT_ID,'serviceDeskId':SERVICE_DESK_ID,'results':results}, indent=2), encoding='utf-8')
for r in results:
    preview = r['body'] if isinstance(r['body'], dict) else str(r['body'])[:1000]
    print(json.dumps({'path':r['path'],'status':r['status'],'bodyType':type(r['body']).__name__,'bodyPreview':preview}, default=str, separators=(',',':')))
